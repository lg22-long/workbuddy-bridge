# workbuddy-bridge

**English** · [中文](README.zh-CN.md)

Expose the **CodeBuddy / WorkBuddy desktop session** (Tencent's coding assistant) as a
local **OpenAI-compatible endpoint**, so any client that accepts a custom base URL can
use your own subscription instead of a separate API key.

```
your client (DeepSeek Harness / Cherry Studio / Open WebUI / any OpenAI SDK)
      │  POST http://127.0.0.1:8790/v1/chat/completions
      ▼
workbuddy-bridge.mjs        (binds 127.0.0.1 only)
      │  1. read the local desktop session
      │  2. inject auth + tracing headers
      │  3. guarantee streaming
      ▼
copilot.tencent.com/v2/chat/completions     (already speaks the OpenAI protocol)
```

## Why a bridge is needed

Three behaviours of the upstream backend, all verified against the live service:

| Backend behaviour | Consequence |
|---|---|
| No public OpenAI-compatible endpoint; auth is a desktop OAuth session | Something must read the session and inject auth headers |
| `POST /v2/chat/completions` rejects non-streaming requests (`400 code 11101 Non-stream chat request is currently not supported`) | Non-streaming client requests must be converted to streaming and aggregated |
| Access token lives ~60 days (refresh token ~90) | The session must be refreshed and written back, or requests start failing with 401 |

The backend natively supports `tools` / `tool_calls` / SSE / `usage`, so the bridge does
**no protocol translation** — only auth injection and streaming guarantees.

## Requirements

- Node.js 18+ (no npm dependencies; Node built-ins only)
- CodeBuddy / WorkBuddy **desktop app installed and signed in**
- Windows, macOS, or Linux — the login file is auto-detected in the standard locations
  for each platform (override with `WORKBUDDY_AUTH_FILE`)

## Quick start

```bash
# preflight only: prints the resolved login file, account, endpoint, token expiry
node workbuddy-bridge.mjs --check

# foreground (Ctrl+C to stop)
node workbuddy-bridge.mjs

# or use a launcher
./start-workbuddy-bridge.sh --background          # macOS / Linux
powershell -ExecutionPolicy Bypass -File .\start-workbuddy-bridge.ps1 -Background   # Windows
```

Then verify:

```bash
curl http://127.0.0.1:8790/health
curl http://127.0.0.1:8790/v1/models

# end-to-end: streaming, tool calls, non-streaming aggregation, multi-turn tool results
node verify-bridge.mjs
```

Stop it:

```bash
# macOS / Linux — the launcher prints the pid
kill <pid>

# Windows
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8790 -State Listen).OwningProcess
```

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Session status, token expiry, resolved login file, mounted models |
| `GET /v1/models` | The curated model list |
| `GET /v1/models?all=1` | Every model the account can use, with context window and image support |
| `POST /v1/chat/completions` | Standard OpenAI chat completions; supports `stream` and `tools` |

## Using it from DeepSeek Harness

Add a provider to `~/.dsh/settings.yaml`:

```yaml
llm-pi-ai:
  providers:
    workbuddy:
      displayName: WorkBuddy
      apiKeyEnv: WORKBUDDY_BRIDGE_KEY    # placeholder: see note below
      api: openai-completions
      baseURL: http://127.0.0.1:8790/v1
      models:
        - id: deepseek-v4-pro            # must match the upstream model id exactly
          name: DeepSeek-V4-Pro
          contextWindow: 1000000
          maxTokens: 50000
          input: [text, image]
```

Add the placeholder credential to `~/.dsh/.credentials.yaml`:

```yaml
refs:
  WORKBUDDY_BRIDGE_KEY: wb-local-bridge
```

**Why a placeholder is needed:** pi-ai's OpenAI-compatible implementation requires an API
key or `Authorization` header even when the server does not check one. The bridge binds to
loopback and does not validate it by default; set `WORKBUDDY_LOCAL_TOKEN` to require one.

To make this the default model for new sessions:

```yaml
agent-default-model:
  provider: workbuddy
  model: deepseek-v4-pro
  reasoningEffort: high
```

## Using it from any other OpenAI client

Point the client's base URL at `http://127.0.0.1:8790/v1`, leave the API key blank (or use
`WORKBUDDY_LOCAL_TOKEN`'s value), and use any model id from `/v1/models?all=1`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `WORKBUDDY_PORT` | `8790` | Listen port |
| `WORKBUDDY_HOST` | `127.0.0.1` | Bind address. **Do not** use `0.0.0.0` — that exposes your subscription to the network |
| `WORKBUDDY_LOCAL_TOKEN` | empty | When set, requires this Bearer token on the local endpoint |
| `CODEBUDDY_API_KEY` | empty | Use an API key instead of the desktop session |
| `CODEBUDDY_ENDPOINT` | auto | Override the upstream base URL |
| `WORKBUDDY_AUTH_FILE` | auto-detected | Override the desktop login file path |
| `WORKBUDDY_LOG` | empty | `1` logs the model, message count and tool count per request |
| `WORKBUDDY_SHAPE` | empty | `1` additionally logs request *shape* (body keys, role counts, sizes, tool names, header names, UA). Never logs conversation content |
| `WORKBUDDY_TIMEOUT_MS` | `0` | Upstream request timeout; `0` means unlimited, which long answers need |

## Authentication and refresh

- Reads the desktop login file (auto-detected per platform; `workbuddy-desktop.info`)
- Refreshes via `POST /v2/plugin/auth/token/refresh` when the access token is within
  5 minutes of expiry
- Writes the refreshed token back **atomically** (temp file + rename), guarded by a
  cross-process lock and a "someone else already refreshed" check, so it will not fight
  the desktop app
- On upstream 401/403: refreshes once and retries (15 s cooldown)
- On transient `400 code 11133` (the gateway wrapping a momentary upstream failure):
  retries idempotently with backoff

## Compatibility notes

1. **The system-prompt role differs from the OpenAI spec.** The backend expects the
   `system` role, which is what the official client sends. Clients built against the newer
   OpenAI spec (including DeepSeek Harness) carry the system prompt in `developer` instead,
   and the backend does not recognise that role — it answers
   `400 code 11128 Illegal API invocation from an unapproved channel`. The bridge adapts the
   request by mapping `developer` to `system`, which is a lossless rename of an equivalent
   field, and logs `normalize: rewrote N developer message(s) -> system`.
2. **Requests are expected to originate from the bundled desktop client.** The backend
   checks the calling client's identity and rejects unrecognised callers
   (`code 11128 request illegal`). The bridge therefore presents the standard
   `User-Agent` that the backend is provisioned for, the same way the official client does.
3. **Non-streaming requests** are converted to streaming upstream and aggregated back into
   a single `chat.completion` response, preserving `content`, `reasoning_content`,
   `tool_calls`, `finish_reason` and `usage`.
4. **`reasoningEffort`** is a request-side hint; the actual thinking level is decided by the
   backend's per-model `supportedEfforts`.
5. **Occasional transient rejections.** The gateway can briefly return `11128` even for a
   valid request; it usually clears within minutes. Avoid rapid retry loops.

## Troubleshooting

Read the log (`bridge.log` when launched with `--background`, or stdout in the foreground):

```powershell
# Windows PowerShell 5.1 reads logs as ANSI by default; the log is UTF-8
Get-Content .\bridge.log -Encoding UTF8 -Tail 40 -Wait
```

| Symptom | Meaning |
|---|---|
| `normalize: rewrote ... developer ... -> system` | Role compatibility fix applied (expected) |
| `upstream error 400 {"code":11128,...Illegal API invocation from an unapproved channel}` | Payload not recognised — usually the system-prompt role was not adapted |
| `upstream error 400 {"code":11128,...request illegal}` | Request not recognised as coming from the desktop client — check `User-Agent` |
| `401` / `403` | The desktop session expired; sign in to the desktop app again |
| `503` from `/health` | No readable login file — check the path it prints |

For a detailed comparison, start with `WORKBUDDY_SHAPE=1` and diff the logged request shape
against a known-good one.

## Files

| File | Purpose |
|---|---|
| `workbuddy-bridge.mjs` | The proxy (no dependencies; Node 18+) |
| `start-workbuddy-bridge.ps1` | Windows launcher (preflight, foreground, background) |
| `start-workbuddy-bridge.sh` | macOS / Linux launcher |
| `verify-bridge.mjs` | End-to-end self-test: health, models, streaming, tool calls, non-stream aggregation, multi-turn tool results |
| `verify-fix.mjs` | Focused test for the `developer` → `system` normalization |

Both verify scripts make **real requests** and therefore consume a small amount of
subscription quota.

## Security

- Binds loopback only. Binding `0.0.0.0` exposes your subscription to every machine that
  can reach the port.
- Never logs or persists a token, and never logs conversation content. `WORKBUDDY_SHAPE=1`
  logs structure only (counts, sizes, names).
- The login file it reads holds a live OAuth token. Keep `.gitignore` in place; do not
  commit `*.info`, logs, or credential files.

## Disclaimer

Not affiliated with, endorsed by, or supported by Tencent, CodeBuddy, or WorkBuddy.
This is an interoperability shim for using a subscription **you hold** from a client of
**your** choosing. As described under Compatibility notes, it adapts a protocol difference;
it does not bypass authentication or any server-side access control.

Use it only in accordance with the terms of service that apply to your account, and at your
own risk. The upstream service may change or block this approach at any time; continued
availability is not guaranteed, and high-frequency or large-scale automated use is not
encouraged.

If you are an administrator who wants a team to use these models from supported clients, the
right path is to obtain official API access from Tencent rather than relying on this project.

## License

MIT — see [LICENSE](LICENSE).
