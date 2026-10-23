// 典型的「模型调工具 → 代码执行工具 → 结果回给模型」两轮循环，OpenAI 兼容协议。
// 工具结果用 TOOL_SUFFIX 改动 —— 重放测试要证明「工具结果变了，第二次调用必须穿透缓存」。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const URL_ = `${MOCK}/v1/chat/completions`;

const tools = [{
  type: 'function',
  function: { name: 'search_orders', description: '查订单', parameters: { type: 'object', properties: { q: { type: 'string' } } } },
}];
const post = (body) =>
  fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json());

const messages = [
  { role: 'system', content: '你是客服助手，先查订单再回答。' },
  { role: 'user', content: '订单 42 为什么延迟' },
];

const first = await post({ model: 'deepseek-chat', messages, tools });
const msg = first.choices[0].message;
messages.push(msg);

for (const tc of msg.tool_calls ?? []) {
  const args = JSON.parse(tc.function.arguments);
  const res = await fetch(`${MOCK}/tool/search?q=${encodeURIComponent(args.q)}`).then((r) => r.text());
  messages.push({ role: 'tool', tool_call_id: tc.id, content: `${res}${process.env.TOOL_SUFFIX ?? ''}` });
}

const second = await post({ model: 'deepseek-chat', messages, tools });
console.log('answer:', second.choices[0].message.content);
console.log('tool-agent-done');
