// 循环实时控制端到端。
// 关键断言：**不改代码、不重跑**，在循环跑着的时候把行为改掉。
import { spawn } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;

function run(script, env = {}) {
  const p = spawn(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return { proc: p, done: new Promise((r) => p.on('exit', () => r(out))) };
}

async function waitLoop(timeout = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const s = await j(`${AM}/api/loops`);
    if (s.loops?.length) return s.loops[0];
    await sleep(100);
  }
  return null;
}

// ── 1. 基线：循环自然跑满 ──
console.log('\n[1] 基线');
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: '__reset__' }) }).catch(() => {});
const base = run('loop-agent.mjs');
const outBase = await base.done;
ok(/rounds=5/.test(outBase), `循环自然跑满 5 轮（源码里 MAX=5）`);

// ── 2. 实时改上限：循环跑着的时候把 5 改成 2 ──
console.log('\n[2] 运行中改上限');
const r2 = run('loop-agent.mjs', { LOOP_DELAY: '400' });
const loop = await waitLoop();
ok(!!loop, `发现循环 ${loop?.loopId?.split('/').pop()}`);
if (loop) {
  await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId: loop.loopId, maxIterations: 2 }) });
}
const out2 = await r2.done;
const rounds2 = Number((out2.match(/rounds=(\d+)/) ?? [])[1]);
ok(rounds2 === 2, `★ 上限实时改为 2，实际跑了 ${rounds2} 轮（没改代码、没重跑）`);

// ── 3. 立即跳出 ──
console.log('\n[3] 立即跳出');
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: loop.loopId, maxIterations: null, breakNow: false }) });
const r3 = run('loop-agent.mjs', { LOOP_DELAY: '400' });
await sleep(1200);
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: loop.loopId, breakNow: true }) });
const out3 = await r3.done;
const rounds3 = Number((out3.match(/rounds=(\d+)/) ?? [])[1]);
ok(rounds3 > 0 && rounds3 < 5, `★ 中途跳出，跑了 ${rounds3} 轮就停了`);

// ── 4. 强制再来一轮：超过源码里的 MAX ──
console.log('\n[4] 强制再来一轮');
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: loop.loopId, breakNow: false, maxIterations: null }) });
const r4 = run('loop-agent.mjs', { LOOP_DELAY: '300' });
// 轮询到第 3 轮再设标志 —— 必须赶在循环自己结束之前，用固定 sleep 会踩时序
for (let i = 0; i < 60; i++) {
  const s = await j(`${AM}/api/loops`);
  if ((s.loops.find((l) => l.loopId === loop.loopId)?.iteration ?? 0) >= 3) break;
  await sleep(100);
}
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: loop.loopId, forceOneMore: true }) });
const out4 = await r4.done;
const rounds4 = Number((out4.match(/rounds=(\d+)/) ?? [])[1]);
ok(rounds4 >= 6, `★ 强制多跑，超过源码 MAX=5，实际 ${rounds4} 轮`);

// ── 5. 轮次上报 ──
console.log('\n[5] 轮次可见');
const st = await j(`${AM}/api/loops`);
ok(st.loops.length > 0 && st.loops[0].iteration > 0, `调试器看得到轮次：第 ${st.loops[0]?.iteration} 轮`);

// 收尾
await j(`${AM}/api/loops`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ loopId: loop.loopId, maxIterations: null, breakNow: false, forceOneMore: false, breakpoint: false }) });

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
