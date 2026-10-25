// 读完流式回答就 abort 自己的 signal 做收尾 —— dsh（DeepSeek Harness）就是这样。
// 探针读的是 tee 出来的副本，慢一步就会撞上这个中止：回答其实是完整的，不能被记成失败。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const ac = new AbortController();
const res = await fetch(`${MOCK}/v1/messages`, {
  method: 'POST',
  signal: ac.signal,
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-x', stream: true, max_tokens: 100, messages: [{ role: 'user', content: 'stream' }] }),
});
const reader = res.body.getReader();
const dec = new TextDecoder();
let sse = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  sse += dec.decode(value, { stream: true });
  if (sse.includes('message_stop')) { ac.abort(); break; } // 收到结束事件立刻收尾
}
console.log('stream-abort-done');
