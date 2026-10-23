// 评分端到端 —— 走一遍 AI 自主迭代的闭环：
//
//   跑 → find_failures 找到「200 但被截断」的调用 → AI 看完内容，用 score_call 记下另一处答错了
//   → 改代码重跑（重放：没改的调用不花钱）→ AI 重判 → compare_runs 说「变好了」，并指出修好了哪几处
//
// 关键断言是那些 HTTP 层看不见的东西：被截断的调用状态码是 200，以前 find_failures 会说「没有失败」。

import { spawn } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
const { TOOLS } = await import('../src/mcp/tools.ts');
const tool = (n) => TOOLS.find((t) => t.name === n);

async function run(env = {}) {
  const p = spawn(process.execPath, [new URL('./score-agent.mjs', import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  await new Promise((r) => p.on('exit', r));
  await sleep(500);
  const runId = (await j(`${AM}/api/runs`))[0]?.run_id;
  const calls = (await j(`${AM}/api/calls?runId=${runId}`)).filter((c) => c.kind === 'llm');
  return { runId, out, calls };
}

// ── 1. 规则判定 ──
console.log('\n[1] 规则判定：200 但被截断');
await fetch(`${MOCK}/__reset`);
const a = await run({ CUT: '1' });
ok(a.out.includes('score-agent-done'), '被调试进程正常跑完');
ok(a.calls.length === 2 && a.calls.every((c) => c.ok === 1), '两次调用 HTTP 层都成功');
ok(a.calls[1]?.failing === 'rule.truncated', `★ 第二次调用落库时就被判为截断（failing=${a.calls[1]?.failing}）`);
ok(!a.calls[0]?.failing, '第一次调用没有被误判');

const ff = await tool('find_failures').run({ runId: a.runId });
ok(ff.includes(a.calls[1].call_id), '★ find_failures 找到了它（以前只看状态码，会说「没有失败」）');
ok(ff.includes('请求成功，但判定失败') && ff.includes('被截断'), '说清了为什么算失败');

const runs = await tool('list_runs').run({ limit: 1 });
ok(runs.includes('处判定失败'), 'list_runs 上看得到这次运行有判定失败');

// ── 2. AI 判定 ──
console.log('\n[2] AI 用 score_call 记下判定');
const s1 = await tool('score_call').run({
  callId: a.calls[0].call_id, name: 'correct', passed: false, comment: '分类应该是「投诉」，不是「咨询」',
});
ok(s1.includes('已记下') && s1.includes('correct'), 'score_call 成功');

const gc = await tool('get_call').run({ callId: a.calls[0].call_id });
ok(gc.includes('【评分】') && gc.includes('分类应该是「投诉」'), '★ get_call 带上了评分和理由');

const ff2 = await tool('find_failures').run({ runId: a.runId });
ok(ff2.includes(a.calls[0].call_id) && ff2.includes('[ai]'), '★ AI 判的失败也进了 find_failures');

const runScore = await tool('score_call').run({ runId: a.runId, name: 'resolved', passed: false, comment: '客户没得到完整回复' });
ok(runScore.includes(`运行 ${a.runId}`), '可以给整次运行打分');

let bad = '';
try { await tool('score_call').run({ callId: 'call_nope', name: 'x', passed: false }); } catch (e) { bad = String(e.message); }
ok(bad.includes('没有这个调用'), '目标不存在时报清楚的错误');

// ── 3. 修好之后重跑、重判、对比 ──
console.log('\n[3] 改完重跑 → 重判 → 对比');
await fetch(`${MOCK}/__reset`);
const b = await run({ CUT: '0', AGENTMAKE_REPLAY: a.runId });
ok((await j(`${MOCK}/__count`)).llm === 1, '没改的第一次调用命中重放缓存，只有第二次真的打了模型');
ok(b.calls.every((c) => !c.failing), '★ 新运行里截断没了');

await tool('score_call').run({ callId: b.calls[0].call_id, name: 'correct', passed: true, comment: '改完分类对了' });
await tool('score_call').run({ runId: b.runId, name: 'resolved', passed: true });

const cmp = await j(`${AM}/api/compare?a=${a.runId}&b=${b.runId}`);
ok(cmp.scores?.verdict === 'better', `★ 对比结论：变好了（实得 ${cmp.scores?.verdict}）`);
ok(cmp.scores?.fixed.includes('#1 rule.truncated') && cmp.scores?.fixed.includes('#0 correct'),
  `★ 指出修好的是哪几处：${cmp.scores?.fixed.join('、')}`);
ok(cmp.scores?.fixed.includes('运行 resolved'), '运行级的判定也算进来了');
ok(cmp.scores?.introduced.length === 0, '没有新冒出来的失败');

const cr = await tool('compare_runs').run({ runA: a.runId, runB: b.runId });
ok(cr.includes('评分：变好了') && cr.includes('修好了'), '★ compare_runs 把结论告诉 AI');

// ── 4. 人在页面上的判定走同一个接口 ──
console.log('\n[4] 人工判定与删除');
const human = await j(`${AM}/api/scores`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callId: b.calls[1].call_id, name: 'tone', passed: false, comment: '语气太生硬', source: 'human' }),
});
ok(human.source === 'human', '人工判定记为 human');
const forged = await j(`${AM}/api/scores`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ callId: b.calls[1].call_id, name: 'x', passed: false, source: 'rule' }),
});
ok(forged.source === 'ai', '接口不允许冒充规则判定');
const del = await j(`${AM}/api/scores/delete`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scoreId: human.score_id }),
});
ok(del.ok, '可以删掉');

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
