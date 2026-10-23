// 连续两次 LLM 调用 —— 用来验证单步（放行后停在下一次）。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

for (const i of [1, 2]) {
  const res = await fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'call ' + i }] }),
  });
  const d = await res.json();
  console.log(`call${i}:`, d.choices?.[0]?.message?.content);
}
console.log('two-done');
