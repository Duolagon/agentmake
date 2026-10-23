// 常驻服务按入站请求切分运行 —— 端到端。
//
//   [1] 每个请求一次运行，挂在进程下面；并发请求的调用不串；不碰模型的请求不出空运行
//   [2] 重启后以上一个进程为基线重放：同样的请求全命中，新问题才真打模型；
//       对比时只给 runB，自动对上基线里「同一触发请求的同一次」
//   [3] AGENTMAKE_GROUP 把运行归组
//   [4] AI 侧（MCP）看得到这套结构

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

/** 起被调试的 server，拿到它的端口和进程运行 id */
async function startServer(env = {}) {
  const before = new Set((await j(`${AM}/api/runs?limit=500`)).map((r) => r.run_id));
  const p = spawn(process.execPath, [new URL('./server-agent.mjs', import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => p.on('exit', r));
  for (let i = 0; i < 100 && !/PORT=\d+/.test(out); i++) await sleep(50);
  const port = Number(out.match(/PORT=(\d+)/)?.[1]);
  let pid = null;
  for (let i = 0; i < 40 && !pid; i++) {
    await sleep(50);
    pid = (await j(`${AM}/api/runs?limit=500`)).find((r) => !before.has(r.run_id) && r.kind === 'process')?.run_id ?? null;
  }
  const ask = (q) =>
    fetch(`http://127.0.0.1:${port}/ask`, { method: 'POST', body: JSON.stringify({ q }) }).then((r) => r.json());
  const stop = async () => {
    await fetch(`http://127.0.0.1:${port}/quit`).catch(() => {});
    await Promise.race([exited, sleep(5000)]);
    await sleep(400);
  };
  return { port, pid, ask, stop, health: () => fetch(`http://127.0.0.1:${port}/health`).then((r) => r.text()) };
}

const runsOf = async (pid) => (await j(`${AM}/api/runs?limit=500`)).filter((r) => r.parent_run_id === pid)
  .sort((a, b) => a.started_at - b.started_at || a.run_id.length - b.run_id.length || (a.run_id < b.run_id ? -1 : 1));
const callsOf = (rid) => j(`${AM}/api/calls?runId=${encodeURIComponent(rid)}`);

// ── 1 ──
console.log('\n[1] 每个入站请求一次运行');
await fetch(`${MOCK}/__reset`);
const s1 = await startServer();
ok(!!s1.port && !!s1.pid, `server 起来了，进程运行 ${s1.pid}`);
await s1.health();
await s1.ask('alpha');                                  // 先单独一个，保证它是基线里的第一个
await Promise.all([s1.ask('beta'), s1.ask('delta')]);    // 再来两个并发的
await s1.stop();

const reqs1 = await runsOf(s1.pid);
ok(reqs1.length === 3, `★ 3 个 POST /ask → 3 次请求级运行；/health 没有冒出空运行（实得 ${reqs1.length}）`);
ok(reqs1.every((r) => r.kind === 'request' && r.trigger === 'POST /ask'), '★ 标着触发它的请求');
ok(reqs1.every((r) => r.http_status === 200 && r.ended_at), '记下了回给客户端的状态码，并已结束');
ok(reqs1.every((r) => r.group_id === s1.pid), '组 = 所在进程');

let isolated = true;
for (const r of reqs1) {
  const cs = await callsOf(r.run_id);
  const llm = cs.filter((c) => c.kind === 'llm');
  const http = cs.filter((c) => c.kind === 'http');
  const full = llm[0] && (await j(`${AM}/api/calls/${encodeURIComponent(llm[0].call_id)}`));
  const q = JSON.parse(full?.messages ?? '[]')[0]?.content?.match(/问题：(\w+)/)?.[1];
  const feedQ = decodeURIComponent(http[0]?.url?.split('/feed/')[1] ?? '');
  if (cs.length !== 2 || llm.length !== 1 || http.length !== 1 || !q || q !== feedQ) isolated = false;
}
ok(isolated, '★ 并发的请求各自只有自己的「抓资料 + 问模型」，没有串到别的请求里');

const procCalls = await callsOf(s1.pid);
ok(procCalls.length === 6, `★ 选进程 = 它处理过的所有请求的调用（实得 ${procCalls.length}）`);
const procRow = (await j(`${AM}/api/runs?limit=500`)).find((r) => r.run_id === s1.pid);
ok(procRow?.child_runs === 3 && procRow?.call_count === 6, '运行列表上进程的计数包含它的请求');

// ── 2 ──
console.log('\n[2] 重启后以上一个进程为基线重放');
await fetch(`${MOCK}/__reset`);
const s2 = await startServer({ AGENTMAKE_REPLAY: s1.pid });
await s2.ask('alpha');      // 和基线第 1 个请求完全一样
await s2.ask('gamma');      // 新问题
await s2.stop();
const hits = await j(`${MOCK}/__count`);
ok(hits.llm === 1, `★ alpha 命中重放缓存，只有 gamma 真的打了模型（实得 ${hits.llm} 次）`);

const reqs2 = await runsOf(s2.pid);
ok(reqs2.length === 2 && reqs2.every((r) => r.replay_of === s1.pid), '★ 新进程的请求都记着基线是上一个进程');

const cmpA = await j(`${AM}/api/compare?b=${reqs2[0].run_id}`);
ok(cmpA.runA === reqs1[0].run_id, `★ 只给 runB，自动对上基线里第 1 个 POST /ask（实得 ${cmpA.runA}）`);
ok(cmpA.divergeAt === null && cmpA.counts.identical === 1, '同样的请求：完全一致');
const cmpG = await j(`${AM}/api/compare?b=${reqs2[1].run_id}`);
ok(cmpG.runA === reqs1[1].run_id && cmpG.divergeAt === 0, '第 2 个请求对上基线第 2 个，并且找出了分歧');

const notReplay = await fetch(`${AM}/api/compare?b=${reqs1[0].run_id}`);
ok(notReplay.status === 400 && (await notReplay.json()).error.includes('不是重放出来的'), '不是重放的运行，说清楚为什么没有缺省基线');

// ── 3 ──
console.log('\n[3] 运行组');
const s3 = await startServer({ AGENTMAKE_GROUP: 'nightly-1' });
await s3.ask('alpha');
await s3.stop();
const g = (await j(`${AM}/api/groups`)).find((x) => x.group_id === 'nightly-1');
ok(g?.runs === 2 && g?.request_runs === 1, `★ 组里有进程 + 请求（实得 ${g?.runs} / ${g?.request_runs}）`);
ok((await callsOf('nightly-1')).length === 2, '组 id 也能当范围查调用');

// ── 4 ──
console.log('\n[4] MCP');
const lr = await tool('list_runs').run({ limit: 5 });
ok(lr.includes('↳') && lr.includes('POST /ask'), '★ list_runs 把请求缩进挂在进程下面');
ok(lr.includes(`«重放自 ${s1.pid}»`), 'list_runs 标出了重放基线');
const lg = await tool('list_runs').run({ groups: true });
ok(lg.includes('nightly-1'), 'list_runs({ groups: true }) 列出运行组');
const cr = await tool('compare_runs').run({ runB: reqs2[0].run_id });
ok(cr.includes(`A=${reqs1[0].run_id}`), '★ compare_runs 只给 runB 也能比');
let err = '';
try { await tool('compare_runs').run({ runB: reqs1[0].run_id }); } catch (e) { err = String(e.message); }
ok(err.includes('不是重放出来的'), '错误原因原样传给 AI，而不是一个 HTTP 400');
const attach = await tool('get_attach_command').run({ replayFrom: s1.pid, group: 'g', language: 'node' });
ok(attach.includes(`AGENTMAKE_REPLAY=${s1.pid}`) && attach.includes('AGENTMAKE_GROUP=g'), '启动命令带上基线和组');

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
