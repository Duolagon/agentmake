// 重放缓存 + 运行对比端到端。
//
// 关键断言不是「有缓存」，而是 **模型确实没有被调用**（拿 mock 的调用计数证明），
// 以及 **改动之后的调用穿透了缓存**。

import { spawn } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;

async function run(script, env = {}) {
  const p = spawn(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  await new Promise((r) => p.on('exit', r));
  await sleep(500);
  const runs = await j(`${AM}/api/runs`);
  return { runId: runs[0]?.run_id, out };
}

const hits = () => j(`${MOCK}/__count`);

// ── 基线 ──
console.log('\n[1] 基线运行');
await fetch(`${MOCK}/__reset`);
const base = await run('nested-agent.mjs');
const baseHits = await hits();
ok(!!base.runId, `基线 runId = ${base.runId}`);
ok(baseHits.llm === 1, `基线真实调用模型 ${baseHits.llm} 次`);

const baseCalls = await j(`${AM}/api/calls?runId=${base.runId}`);
ok(baseCalls.filter((c) => c.kind === 'llm').length === 1, '记录到 1 次 LLM 调用');

// ── 完全相同的重放：一次都不该打模型 ──
console.log('\n[2] 输入不变的重放');
await fetch(`${MOCK}/__reset`);
const same = await run('nested-agent.mjs', { AGENTMAKE_REPLAY: base.runId });
const sameHits = await hits();
ok(sameHits.llm === 0, '★ 模型一次都没被调用（全部命中缓存）');
ok(same.out.includes('nested-done'), '被调试进程正常跑完，拿到了缓存的响应');

const sameCalls = (await j(`${AM}/api/calls?runId=${same.runId}`)).filter((c) => c.kind === 'llm');
ok(sameCalls.every((c) => c.replayed), '这些调用被标记为 replayed');

// ── 改了 prompt：应该穿透缓存 ──
console.log('\n[3] 改动后的重放');
await fetch(`${MOCK}/__reset`);
const changed = await run('nested-agent.mjs', {
  AGENTMAKE_REPLAY: base.runId,
  EXTRA_RULE: '并且必须用一句话概括',   // 改变 prompt 内容
});
const changedHits = await hits();
ok(changedHits.llm === 1, '★ 被改动的调用穿透缓存，真的打了模型');
ok(changed.out.includes('nested-done'), '正常跑完');

// ── 对比 ──
console.log('\n[4] 运行对比');
const cmp = await j(`${AM}/api/compare?a=${base.runId}&b=${changed.runId}`);
ok(cmp.counts.a === 1 && cmp.counts.b === 1, '两次运行都是 1 次 LLM 调用');
ok(cmp.divergeAt === 0, '★ 定位到第 0 次调用是分歧点');
ok(cmp.pairs[0].changedIn === 'messages', `分歧字段 = ${cmp.pairs[0].changedIn}`);
ok(!!cmp.pairs[0].snippet, '给出了差异片段');

const cmpSame = await j(`${AM}/api/compare?a=${base.runId}&b=${same.runId}`);
ok(cmpSame.divergeAt === null, '★ 未改动的重放：请求完全一致，无分歧');
ok(cmpSame.counts.identical === 1, '标记为完全相同');
ok(cmpSame.replayed.b === 1, '对比结果里能看到 B 是重放的');

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
