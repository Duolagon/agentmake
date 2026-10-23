// 典型的手写 agent 循环：起草 → 评审 → 修订，源码里写死最多 5 轮。
const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;
const DELAY = Number(process.env.LOOP_DELAY || 0);

async function callModel(p) {
  const r = await fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: p }] }),
  });
  return (await r.json()).choices[0].message.content;
}

async function refine() {
  const MAX = Number(process.env.LOOP_MAX || 5); // ← 源码常量，运行时本来改不了
  let rounds = 0;
  for (let i = 0; i < MAX; i++) {
    await callModel(`第 ${i + 1} 轮评审`);
    rounds++;
    if (DELAY) await new Promise((r) => setTimeout(r, DELAY));
  }
  return rounds;
}
console.log('rounds=' + (await refine()));
