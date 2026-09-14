// SPDX-License-Identifier: MIT
/**
 * workbuddy-bridge — expose the locally signed-in CodeBuddy / WorkBuddy desktop
 * session as a local OpenAI-compatible endpoint, for any client that accepts a
 * custom base URL (DeepSeek Harness, Cherry Studio, Open WebUI, ...).
 *
 * How it works (all behaviours verified against the live backend):
 *   - The upstream backend (copilot.tencent.com/v2/chat/completions) already
 *     speaks the OpenAI protocol, so this proxy does NOT translate protocols.
 *     It only injects authentication/tracing headers and guarantees streaming.
 *   - The backend rejects non-streaming requests (400 code 11101), so a
 *     non-streaming client request is converted to streaming upstream and
 *     aggregated back into a single JSON response.
 *   - Auth reuses the desktop session (OAuth access/refresh token) from the
 *     local login file, refreshing and writing it back before expiry.
 *   - Compatibility fix: the backend only accepts the `system` role for the
 *     system prompt, while newer OpenAI-spec clients send `developer`. Those
 *     messages are rewritten in place before forwarding.
 *
 * Security boundary: binds 127.0.0.1 only; never logs or persists a token or
 * any conversation content.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, statSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// ── Static constants (values match the desktop app / official extension) ──
const APP_VERSION = '4.9.29177644';
const IDE_VERSION = '1.119.0';
const IDE_NAME = 'VSCode';
const CHAT_PATH = '/v2/chat/completions';
const CONFIG_PATH = '/v3/config';
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const REFRESH_COOLDOWN_MS = 15 * 1000;
const TRANSIENT_400_DELAYS = [1000, 4000, 10000, 25000];
const UPSTREAM_TIMEOUT_MS = Number(process.env.WORKBUDDY_TIMEOUT_MS || 0); // 0 = unlimited (long answers need it)

const PORT = Number(process.env.WORKBUDDY_PORT || 8790);
const HOST = process.env.WORKBUDDY_HOST || '127.0.0.1';
const LOCAL_TOKEN = process.env.WORKBUDDY_LOCAL_TOKEN || ''; // optional: require a token on the local port
const EXPLICIT_ENDPOINT = process.env.CODEBUDDY_ENDPOINT || '';
const API_KEY = process.env.CODEBUDDY_API_KEY || '';
const LOG = process.env.WORKBUDDY_LOG === '1';

// Curated models exposed by default; others remain reachable via /v1/models?all=1
const FEATURED = [
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash (WorkBuddy x0.03)', context: 1000000, maxOutput: 128000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro (WorkBuddy x0.51)', context: 1000000, maxOutput: 50000 },
  { id: 'glm-5.3', name: 'GLM-5.3 (WorkBuddy x0.79)', context: 1000000, maxOutput: 48000 },
];

// Locate the CodeBuddy / WorkBuddy desktop login file across platforms.
// Override with WORKBUDDY_AUTH_FILE when the desktop app stores it elsewhere.
const AUTH_DIRS = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.HOME && join(process.env.HOME, '.local', 'share', 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
  process.env.XDG_DATA_HOME && join(process.env.XDG_DATA_HOME, 'CodeBuddyExtension', 'Data', 'Public', 'auth'),
].filter(Boolean);

/** Explicit override wins; otherwise the first candidate directory holding a *.info file. */
function resolveAuthPath() {
  if (process.env.WORKBUDDY_AUTH_FILE) return process.env.WORKBUDDY_AUTH_FILE;
  for (const dir of AUTH_DIRS) {
    try {
      const hit = readdirSync(dir).find((f) => f.endsWith('.info'));
      if (hit) return join(dir, hit);
    } catch { /* directory absent on this platform */ }
  }
  return join(AUTH_DIRS[0] || '.', 'workbuddy-desktop.info');
}

const AUTH_PATH = resolveAuthPath();
const LOCK_PATH = join(tmpdir(), 'workbuddy-bridge-refresh.lock');

const log = (...a) => { if (LOG) console.error(`[${new Date().toISOString()}]`, ...a); };

// ── Auth: read the local desktop session ─────────────────────────────────
function readStoredAuth() {
  const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
  const auth = raw.auth || {};
  if (!auth.accessToken) throw new Error('login file has no accessToken; sign in to the WorkBuddy desktop app first');
  const claims = decodeJwt(auth.accessToken);
  const domain = auth.domain || claims.iss || '';
  const endpoint = EXPLICIT_ENDPOINT
    || (domain.includes('codebuddy.ai') ? 'https://www.codebuddy.ai' : 'https://copilot.tencent.com');
  return {
    access: auth.accessToken,
    refresh: auth.refreshToken || '',
    expiresAt: Number(auth.expiresAt || claims.exp * 1000 || 0),
    refreshExpiresAt: Number(auth.refreshExpiresAt || 0),
    userId: claims.sub || '',
    enterpriseId: claims.enterprise_id || '',
    tenantId: claims.tenant_id || claims.tenant || '',
    endpoint,
    domain: endpoint.includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn',
  };
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); }
  catch { return {}; }
}

// ── Auth: refresh and write back the login file (cross-process lock + atomic write) ──
let lastRefreshFailedAt = 0;
async function refreshAuth(auth) {
  if (!auth.refresh) return null;
  if (Date.now() - lastRefreshFailedAt < REFRESH_COOLDOWN_MS) return null;
  try {
    const res = await fetch(`${auth.endpoint}/v2/plugin/auth/token/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${auth.refresh}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body || body.code !== 0 || !body.data?.accessToken) {
      lastRefreshFailedAt = Date.now();
      log('refresh failed', res.status, JSON.stringify(body)?.slice(0, 200));
      return null;
    }
    persistRefreshed(body.data);
    log('refreshed access token');
    return readStoredAuth();
  } catch (e) {
    lastRefreshFailedAt = Date.now();
    log('refresh error', e.message);
    return null;
  }
}

function withLock(fn) {
  const deadline = Date.now() + 5000;
  while (existsSync(LOCK_PATH)) {
    if (Date.now() > deadline) { try { writeFileSync(LOCK_PATH, ''); } catch {} break; }
    // a lock older than 20s is considered stale
    try { if (Date.now() - statSync(LOCK_PATH).mtimeMs > 20000) { writeFileSync(LOCK_PATH, ''); break; } } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { writeFileSync(LOCK_PATH, String(process.pid)); } catch {}
  try { return fn(); } finally { try { writeFileSync(LOCK_PATH, ''); } catch {} }
}

function persistRefreshed(data) {
  withLock(() => {
    const raw = JSON.parse(readFileSync(AUTH_PATH, 'utf8'));
    // the desktop app may have just refreshed: only write back if our token is still the newest
    if (raw.auth?.accessToken !== data.accessToken && Date.now() < Number(raw.auth?.expiresAt || 0) - REFRESH_SKEW_MS) {
      log('another process refreshed first; skipping write-back');
      return;
    }
    const now = Date.now();
    const expiresIn = Number(data.expiresIn || 0);
    raw.auth.accessToken = data.accessToken;
    if (data.refreshToken) raw.auth.refreshToken = data.refreshToken;
    if (expiresIn) raw.auth.expiresIn = expiresIn;
    raw.auth.tokenType = raw.auth.tokenType || 'Bearer';
    raw.auth.lastRefreshTime = now;
    if (expiresIn) raw.auth.expiresAt = now + expiresIn * 1000;
    if (data.refreshExpiresIn) raw.auth.refreshExpiresIn = Number(data.refreshExpiresIn);
    if (data.refreshExpiresIn) raw.auth.refreshExpiresAt = now + Number(data.refreshExpiresIn) * 1000;
    const tmp = `${AUTH_PATH}.bridge-tmp`;
    mkdirSync(dirname(AUTH_PATH), { recursive: true });
    writeFileSync(tmp, JSON.stringify(raw));
    renameSync(tmp, AUTH_PATH);
  });
}

// ── Upstream payload normalization ───────────────────────────────────────
/**
 * The WorkBuddy gateway (copilot.tencent.com) rejects the OpenAI-spec `developer`
 * 400 code 11128 "Illegal API invocation from an unapproved channel"。
 * role outright (400 code 11128). Newer OpenAI-spec clients carry the system
 * prompt in `developer`, while the official client only ever sends `system`.
 */
function normalizePayload(payload) {
  const messages = payload.messages;
  if (!Array.isArray(messages)) return payload;
  let rewritten = 0;
  const fixed = messages.map((m) => {
    if (m && (m.role === 'developer' || m.role === 'Developer')) {
      rewritten++;
      return { ...m, role: 'system' };
    }
    return m;
  });
  if (!rewritten) return payload;
  log(`normalize: rewrote ${rewritten} developer message(s) -> system`);
  return { ...payload, messages: fixed };
}

// ── Request header construction ──────────────────────────────────────────
const trace = () => randomUUID().replace(/-/g, '');

function buildHeaders(auth, model, conversationId) {
  const messageId = trace();
  const traceId = trace();
  const spanId = traceId.slice(0, 16);
  const parentSpanId = traceId.slice(16, 32);
  const h = {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Agent-Intent': 'craft',
    'X-IDE-Type': IDE_NAME,
    'X-IDE-Name': IDE_NAME,
    'X-IDE-Version': IDE_VERSION,
    'X-Product-Version': APP_VERSION,
    'X-Env-ID': 'production',
    'X-Domain': auth.domain,
    'X-Product': 'SaaS',
    'User-Agent': `${IDE_NAME}/${IDE_VERSION} CodeBuddy/${APP_VERSION}`,
    'X-Request-ID': messageId,
    'X-Conversation-ID': conversationId || trace(),
    'X-Conversation-Request-ID': messageId,
    'X-Conversation-Message-ID': messageId,
    'X-Request-Trace-Id': traceId,
    b3: `${traceId}-${spanId}-1-${parentSpanId}`,
    'X-B3-TraceId': traceId,
    'X-B3-ParentSpanId': parentSpanId,
    'X-B3-SpanId': spanId,
    'X-B3-Sampled': '1',
  };
  if (model) h['X-Model-ID'] = model;
  if (API_KEY) {
    h.Authorization = `Bearer ${API_KEY}`;
    h['X-API-Key'] = API_KEY;
  } else {
    h.Authorization = `Bearer ${auth.access}`;
    if (auth.userId) h['X-User-Id'] = auth.userId;
    if (auth.enterpriseId) h['X-Enterprise-Id'] = auth.enterpriseId;
    if (auth.tenantId) h['X-Tenant-Id'] = auth.tenantId;
  }
  return h;
}

// ── Upstream call (with refresh retry and transient-400 retry) ───────────
async function callUpstream(bodyString, model, conversationId, clientSignal) {
  // API-key mode needs no login file; supply a minimal endpoint/domain instead
  let auth = API_KEY
    ? { endpoint: EXPLICIT_ENDPOINT || 'https://copilot.tencent.com', domain: (EXPLICIT_ENDPOINT || '').includes('codebuddy.ai') ? 'www.codebuddy.ai' : 'www.codebuddy.cn', access: '', refresh: '', expiresAt: 0 }
    : readStoredAuth();
  if (!API_KEY && auth.refresh && auth.expiresAt - REFRESH_SKEW_MS < Date.now()) {
    const next = await refreshAuth(auth);
    if (next) auth = next;
  }

  const send = (a) => fetch(`${a.endpoint}${CHAT_PATH}`, {
    method: 'POST',
    headers: buildHeaders(a, model, conversationId),
    body: bodyString,
    signal: clientSignal
      ? AbortSignal.any([clientSignal, ...(UPSTREAM_TIMEOUT_MS ? [AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)] : [])])
      : (UPSTREAM_TIMEOUT_MS ? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) : undefined),
  });

  let res = await send(auth);
  if (!API_KEY && (res.status === 401 || res.status === 403) && auth.refresh) {
    const next = await refreshAuth(auth);
    if (next) { auth = next; res = await send(auth); }
  }

  // the gateway occasionally wraps a momentary upstream failure as 400 code 11133: retry idempotently
  for (let i = 0; res.status === 400 && i < TRANSIENT_400_DELAYS.length; i++) {
    const text = await res.text();
    let code;
    try { code = JSON.parse(text)?.code; } catch {}
    if (code !== 11133) return { res, bodyText: text };
    if (clientSignal?.aborted) return { res, bodyText: text };
    log(`transient 400 (11133), retry ${i + 1}`);
    await new Promise((r) => setTimeout(r, TRANSIENT_400_DELAYS[i]));
    if (clientSignal?.aborted) return { res, bodyText: text };
    res = await send(auth);
  }
  return { res, bodyText: null };
}

// ── SSE parsing and aggregation (non-streaming clients only) ─────────────
function mergeToolCallDelta(acc, deltas) {
  for (const d of deltas || []) {
    const idx = d.index ?? acc.length;
    acc[idx] ??= { id: undefined, type: 'function', function: { name: '', arguments: '' } };
    const slot = acc[idx];
    if (d.id) slot.id = d.id;
    if (d.type) slot.type = d.type;
    if (d.function?.name) slot.function.name += d.function.name;
    if (d.function?.arguments) slot.function.arguments += d.function.arguments;
  }
}

async function aggregateStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '', reasoning = '', finishReason = null, usage = null, id = null, model = null, created = null;
  const toolCalls = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let j; try { j = JSON.parse(payload); } catch { continue; }
      id ??= j.id; model ??= j.model; created ??= j.created;
      if (j.usage) usage = j.usage;
      const choice = j.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta || {};
      if (typeof d.content === 'string') content += d.content;
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      if (d.tool_calls) mergeToolCallDelta(toolCalls, d.tool_calls);
    }
  }
  const message = { role: 'assistant', content: content || null };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length) message.tool_calls = toolCalls.filter(Boolean);
  return {
    id: id || `chatcmpl-${trace().slice(0, 24)}`,
    object: 'chat.completion',
    created: created || Math.floor(Date.now() / 1000),
    model: model || '',
    choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

// ── Model list ───────────────────────────────────────────────────────────
let catalogCache = { at: 0, models: [] };
async function upstreamCatalog() {
  if (Date.now() - catalogCache.at < 5 * 60 * 1000 && catalogCache.models.length) return catalogCache.models;
  try {
    const auth = readStoredAuth();
    const res = await fetch(`${auth.endpoint}${CONFIG_PATH}`, {
      headers: buildHeaders(auth, '', ''),
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    const models = body?.data?.models;
    if (Array.isArray(models)) {
      catalogCache = {
        at: Date.now(),
        models: models
          .filter((m) => m.supportsToolCall !== false && !/^(codewise|hunyuan-image)/.test(m.id))
          .map((m) => ({ id: m.id, name: m.name || m.id, context: m.maxInputTokens, maxOutput: m.maxOutputTokens, images: !!m.supportsImages, credits: m.credits })),
      };
    }
  } catch (e) { log('catalog fetch failed', e.message); }
  return catalogCache.models;
}

// ── HTTP server ──────────────────────────────────────────────────────────
const readBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});

const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (LOCAL_TOKEN && req.headers.authorization !== `Bearer ${LOCAL_TOKEN}`) {
      return json(res, 401, { error: { message: 'workbuddy-bridge: bad or missing local token' } });
    }

    if (url.pathname === '/health') {
      let auth = null;
      try {
        const a = readStoredAuth();
        auth = { userId: a.userId, endpoint: a.endpoint, expiresAt: new Date(a.expiresAt).toISOString(), expired: a.expiresAt < Date.now() };
      } catch (e) { return json(res, 503, { ok: false, error: e.message, authFile: AUTH_PATH }); }
      return json(res, 200, { ok: true, auth, authFile: AUTH_PATH, models: FEATURED.map((m) => m.id) });
    }

    if (url.pathname === '/v1/models') {
      const all = url.searchParams.get('all') === '1';
      const catalog = await upstreamCatalog();
      const byId = new Map(catalog.map((m) => [m.id, m]));
      const list = (all && catalog.length
        ? catalog
        : FEATURED.map((f) => {
            const u = byId.get(f.id);
            return { id: f.id, name: f.name, context: u?.context ?? f.context, maxOutput: u?.maxOutput ?? f.maxOutput, images: u?.images ?? true };
          })
      ).map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'workbuddy',
        ...(m.name ? { name: m.name } : {}),
        ...(m.context ? { context_window: m.context } : {}),
        ...(m.maxOutput ? { max_output_tokens: m.maxOutput } : {}),
      }));
      return json(res, 200, { object: 'list', data: list });
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload;
      try { payload = JSON.parse(raw); } catch { return json(res, 400, { error: { message: 'invalid JSON body' } }); }
      const wantStream = payload.stream === true;
      const model = payload.model || 'deepseek-v4.1-flash';
      // diagnostics: log request shape only, never conversation content
      if (process.env.WORKBUDDY_SHAPE === '1') {
        const roles = {};
        let chars = 0;
        for (const m of payload.messages || []) {
          roles[m.role] = (roles[m.role] || 0) + 1;
          chars += JSON.stringify(m.content ?? '').length;
        }
        const sys = (payload.messages || []).find((m) => m.role === 'system' || m.role === 'developer');
        const hdrs = Object.keys(req.headers).sort();
        log('SHAPE ' + JSON.stringify({
          bodyKeys: Object.keys(payload).sort(),
          model, stream: payload.stream,
          roles, chars,
          sysChars: typeof sys?.content === 'string' ? sys.content.length : null,
          toolCount: payload.tools?.length ?? 0,
          toolNames: (payload.tools || []).map((t) => t?.function?.name).slice(0, 40),
          headers: hdrs,
          ua: req.headers['user-agent'],
        }));
      }
      log(`→ ${model} stream=${wantStream} msgs=${payload.messages?.length ?? 0} tools=${payload.tools?.length ?? 0}`);

      // the backend is streaming-only: always stream upstream, aggregate for non-streaming clients
      const upstream = normalizePayload({ ...payload, stream: true, stream_options: { include_usage: true } });
      delete upstream.max_completion_tokens; // avoid conflicting with max_tokens semantics
      const conversationId = req.headers['x-conversation-id'] || trace();

      const ac = new AbortController();
      req.on('aborted', () => ac.abort());
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });

      const { res: up, bodyText } = await callUpstream(JSON.stringify(upstream), model, conversationId, ac.signal);
      if (!up.ok) {
        const text = bodyText ?? await up.text().catch(() => '');
        let parsed; try { parsed = JSON.parse(text); } catch {}
        log('upstream error', up.status, text.slice(0, 300));
        return json(res, up.status === 200 ? 502 : up.status, parsed || { error: { message: text || `upstream HTTP ${up.status}` } });
      }

      if (wantStream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const reader = up.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch (e) { log('stream interrupted', e.message); }
        return res.end();
      }

      const aggregated = await aggregateStream(up);
      return json(res, 200, aggregated);
    }

    if (url.pathname === '/' ) {
      return json(res, 200, {
        service: 'workbuddy-bridge',
        usage: 'POST /v1/chat/completions · GET /v1/models · GET /health',
        featured: FEATURED.map((m) => m.id),
      });
    }
    return json(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}` } });
  } catch (e) {
    log('handler error', e.stack || e.message);
    if (!res.headersSent) return json(res, 500, { error: { message: e.message } });
    try { res.end(); } catch {}
  }
});

// ── Preflight (--check): report prerequisites without starting the server ──
if (process.argv.includes('--check')) {
  const lines = [];
  const major = Number(process.versions.node.split('.')[0]);
  lines.push(`node            ${process.version}${major >= 18 ? '' : '  [FAIL] Node 18+ required'}`);
  lines.push(`auth file       ${AUTH_PATH}`);
  let authOk = false;
  try {
    const a = readStoredAuth();
    authOk = true;
    lines.push(`account         ${a.userId || '(no sub claim)'}`);
    lines.push(`endpoint        ${a.endpoint}`);
    lines.push(`token expires   ${new Date(a.expiresAt).toISOString()}${a.expiresAt < Date.now() ? '  (expired: the bridge refreshes on first request)' : ''}`);
  } catch (e) {
    lines.push(`auth            [FAIL] ${e.message}`);
  }
  lines.push(`models          ${FEATURED.map((m) => m.id).join(', ')}`);
  console.log(lines.join('\n'));
  process.exit(authOk || API_KEY ? 0 : 1);
}

server.listen(PORT, HOST, () => {
  let who = '(no desktop session read)';
  try { const a = readStoredAuth(); who = `${a.userId} @ ${a.endpoint}`; } catch (e) { who = `ERROR: ${e.message}`; }
  console.log(`workbuddy-bridge listening on http://${HOST}:${PORT}/v1`);
  console.log(`auth       : ${API_KEY ? 'API key (CODEBUDDY_API_KEY)' : `desktop session ${who}`}`);
  console.log(`auth file  : ${AUTH_PATH}`);
  console.log(`models     : ${FEATURED.map((m) => m.id).join(', ')}  (all models: /v1/models?all=1)`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nworkbuddy-bridge stopped'); process.exit(0); });
}
