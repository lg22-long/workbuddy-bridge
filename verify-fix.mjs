// Verify the normalization fix THROUGH the bridge: a developer-role request must now reach
// the model (before the fix it came back as 400 code 11128), and non-stream/tools must still work.
const BASE = process.env.BRIDGE || 'http://127.0.0.1:8790';
let fail = 0;
const ok = (c, label, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`); if (!c) fail++; };

// 1) the previously-failing shape: role "developer"
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash', stream: false, max_completion_tokens: 32000,
      messages: [
        { role: 'developer', content: 'You are an AI agent powered by DeepSeek Harness. Your working directory is D:\\harness.' },
        { role: 'user', content: 'Reply with exactly: fixed' },
      ],
    }),
  });
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content ?? '';
  ok(r.status === 200 && content.length > 0, 'developer-role request now succeeds (was 400 code 11128)', JSON.stringify(content).slice(0, 60));
}

// 2) developer + full DSH tool set + long history
{
  const names = ['ask_user_question', 'create_goal', 'edit', 'exit_plan_mode', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list', 'job_output', 'list_agents', 'present', 'pwsh', 'ralph', 'read', 'read_image', 'send_message', 'sidebar_open', 'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal', 'web_fetch', 'web_search', 'workflow', 'write'];
  const messages = [{ role: 'developer', content: 'You are a coding agent working in D:\\harness.' }];
  for (let i = 0; i < 60; i++) {
    const k = i % 3;
    if (k === 0) messages.push({ role: 'user', content: 'Continue.' });
    else if (k === 1) messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'read', arguments: '{"path":"a.ts"}' } }] });
    else messages.push({ role: 'tool', tool_call_id: `c${i - 1}`, content: 'export const x = 1;' });
  }
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash', stream: false, store: true, max_completion_tokens: 32000,
      messages,
      tools: names.map((n) => ({ type: 'function', function: { name: n, description: 'Workspace tool.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } })),
    }),
  });
  const j = await r.json();
  ok(r.status === 200 && j.choices?.[0]?.message, 'real client shape (developer + 28 tools + 61 messages) succeeds', `status=${r.status}`);
}

// 3) streaming with developer role + tool calling
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-x' },
    body: JSON.stringify({
      model: 'deepseek-v4-pro', stream: true, stream_options: { include_usage: true },
      messages: [{ role: 'developer', content: 'You are a coding agent.' }, { role: 'user', content: 'What is the weather in Beijing? Call the tool.' }],
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    }),
  });
  const text = await r.text();
  ok(r.status === 200 && text.includes('get_weather') && text.includes('"usage"'), 'developer + streaming + tool_calls + usage', `status=${r.status}`);
}

// 4) regression: system role still works
{
  const r = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', stream: false, messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Reply with exactly: pong' }] }),
  });
  const j = await r.json();
  ok(r.status === 200 && /pong/i.test(j.choices?.[0]?.message?.content ?? ''), 'system-role regression check', JSON.stringify(j.choices?.[0]?.message?.content));
}

console.log(fail === 0 ? '\nall checks passed' : `\n${fail} check(s) failed`);
process.exit(fail === 0 ? 0 : 1);
