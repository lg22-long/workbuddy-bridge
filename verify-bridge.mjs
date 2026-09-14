// End-to-end verification of workbuddy-bridge against the real WorkBuddy backend
const BASE = process.env.BRIDGE || 'http://127.0.0.1:8790';
let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
};

// 1) health
const health = await (await fetch(`${BASE}/health`)).json();
ok(health.ok === true, '/health ok', JSON.stringify(health.auth));

// 2) models
const models = await (await fetch(`${BASE}/v1/models`)).json();
ok(models.object === 'list' && models.data.length === 3, '/v1/models returns the 3 curated models', models.data.map((m) => m.id).join(', '));
const all = await (await fetch(`${BASE}/v1/models?all=1`)).json();
ok(all.data.length > 10, '/v1/models?all=1 returns the full catalog', `${all.data.length} models`);

// 3) streaming + tool calls
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-dsh-local' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'What is the weather in Beijing? Call the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    }),
  });
  ok(r.status === 200 && (r.headers.get('content-type') || '').includes('text/event-stream'), 'streaming request returns 200 text/event-stream', `status=${r.status}`);
  const text = await r.text();
  const sawToolCall = text.includes('tool_calls') && text.includes('get_weather');
  const sawUsage = text.includes('"usage"') && text.includes('prompt_tokens');
  const sawDone = text.includes('[DONE]');
  ok(sawToolCall, 'streaming returns native tool_calls');
  ok(sawUsage, 'streaming final chunk carries usage');
  ok(sawDone, 'stream ends with [DONE]');
}

// 4) non-streaming (bridge must convert to upstream streaming and aggregate)
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-dsh-local' },
    body: JSON.stringify({ model: 'glm-5.3', stream: false, messages: [{ role: 'user', content: 'Reply with exactly: pong' }] }),
  });
  const j = await r.json();
  ok(r.status === 200 && j.object === 'chat.completion', 'non-streaming request returns 200 chat.completion', `status=${r.status}`);
  const msg = j.choices?.[0]?.message;
  ok(typeof msg?.content === 'string' && msg.content.length > 0, 'non-streaming aggregates content', JSON.stringify(msg?.content)?.slice(0, 80));
  ok(!!j.usage && j.usage.prompt_tokens > 0, 'non-streaming carries usage', JSON.stringify(j.usage)?.slice(0, 120));
  ok(j.choices?.[0]?.finish_reason === 'stop', 'finish_reason=stop', j.choices?.[0]?.finish_reason);
}

// 5) multi-turn tool result round-trip (what an agent loop actually does)
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      stream: false,
      messages: [
        { role: 'user', content: 'Weather in Beijing?' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Beijing"}' } }] },
        { role: 'tool', tool_call_id: 'call_1', content: '{"tempC":21,"sky":"clear"}' },
      ],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    }),
  });
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  ok(r.status === 200 && /21|clear/i.test(content), 'model answers after multi-turn tool results are returned', JSON.stringify(content).slice(0, 100));
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
