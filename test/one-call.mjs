// 最小被调试对象：发一次 LLM 调用就退出。断点 e2e 用它当靶子。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

const res = await fetch(`${MOCK}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sk-SECRET' },
  body: JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: '原始系统提示' },
      { role: 'user', content: process.env.USER_MSG || '原始用户消息' },
    ],
    temperature: 0.3,
    response_format: { type: 'json_object' },
  }),
});
const data = await res.json();
console.log('reply:', data.choices?.[0]?.message?.content);
console.log('agent-done');
