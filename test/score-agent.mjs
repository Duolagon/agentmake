// 两次调用的小 agent：先分类，再写回复。CUT=1 时第二次调用的 max_tokens 给得太小，
// 回答被截断 —— HTTP 200，日志里一切「成功」，只有规则判定看得出来。
const URL_ = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}/v1/chat/completions`;
const post = (body) =>
  fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then((r) => r.json());

const ticket = '订单延迟三天，客户要投诉';
const kind = await post({
  model: 'deepseek-chat',
  messages: [{ role: 'system', content: '给工单分类' }, { role: 'user', content: ticket }],
});
const reply = await post({
  model: 'deepseek-chat',
  max_tokens: process.env.CUT === '1' ? 3 : 512,
  messages: [{ role: 'system', content: '写一段给客户的回复' }, { role: 'user', content: ticket }],
});
console.log('kind:', kind.choices[0].message.content);
console.log('reply:', reply.choices[0].message.content, `(${reply.choices[0].finish_reason})`);
console.log('score-agent-done');
