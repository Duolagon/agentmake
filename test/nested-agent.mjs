// 有函数层级的被调试对象，用来验证执行图能推导出调用链。
// 结构刻意仿照 news：一个编排函数分出两条支路，一条抓数据、一条调模型。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

async function httpGet(path) {
  return fetch(`${MOCK}${path}`).then((r) => r.text());
}

async function scoutOne(i) {
  return httpGet(`/feed/${i}`);
}

async function gather() {
  return Promise.all([scoutOne(1), scoutOne(2), scoutOne(3)]);
}

async function callModel(prompt) {
  const r = await fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }),
  });
  return (await r.json()).choices?.[0]?.message?.content;
}

async function compose(items) {
  // 刻意造一段长 prompt：既贴近真实（材料是运行时拼出来的），
  // 也让 MCP 的 maxChars 截断有东西可截
  const body = items.map((t, i) => `[${i + 1}] 材料内容：${'内容'.repeat(60)}`).join('\n');
  // EXTRA_RULE 用来在重放测试里制造一处 prompt 改动
  const extra = process.env.EXTRA_RULE ? `\n额外要求：${process.env.EXTRA_RULE}` : '';
  return callModel(`总结以下 ${items.length} 条材料，输出三句话：${extra}\n${body}`);
}

async function orchestrate() {
  const items = await gather();
  return compose(items);
}

console.log('result:', await orchestrate());
console.log('nested-done');
