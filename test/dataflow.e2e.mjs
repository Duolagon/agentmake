// 「观看」画面端到端：数据流、规则判定、循环逐轮，在一个真实的常驻服务 agent 上。
//
//   [1] 工具响应体被记下来了（数据流的原料），而且没有原样进事件日志
//   [2] 连线上：loadHistory 给了 12 条，analyze 的 prompt 只用了 5 条 —— 3 个请求里 3 次
//   [3] 规则判定挂在节点上；循环按请求各自数轮次（不会第 2 个请求从第 4 轮开始数）
//   [4] 异常栏把这两件事报出来；修好之后（FULL_HISTORY=1）「丢数据」就不再报 —— 不误报

import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const AM = 'http://127.0.0.1:8787';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;

async function agent(env = {}) {
  const before = new Set((await j(`${AM}/api/runs?limit=500`)).map((r) => r.run_id));
  const p = spawn(process.execPath, [new URL('./ticket-agent.mjs', import.meta.url).pathname], {
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
  const send = (id) =>
    fetch(`http://127.0.0.1:${port}/tickets`, { method: 'POST', body: JSON.stringify({ id, body: `订单 ${id} 延迟三天还没到` }) }).then((r) => r.json());
  const stop = async () => {
    await fetch(`http://127.0.0.1:${port}/quit`).catch(() => {});
    await Promise.race([exited, sleep(5000)]);
    await sleep(500);
  };
  return { pid, send, stop };
}

const flowOf = (rid) => j(`${AM}/api/flow?runId=${encodeURIComponent(rid)}`);
const step = (f, label) => f.steps.find((s) => s.label === label);

// ── 1 ──
console.log('\n[1] 工具响应体');
const a = await agent();
ok(!!a.pid, `agent 起来了，进程运行 ${a.pid}`);
await a.send(41);
await Promise.all([a.send(42), a.send(43)]);
await a.stop();

const calls = await j(`${AM}/api/calls?runId=${a.pid}`);
const hist = calls.find((c) => c.kind === 'http' && String(c.url).includes('/history/'));
const histRow = hist && (await j(`${AM}/api/calls/${encodeURIComponent(hist.call_id)}`));
ok(histRow?.response_bytes > 500, `★ 记下了 loadHistory 的响应体（${histRow?.response_bytes} 字节）`);
ok(JSON.parse(histRow?.response_body ?? '[]').length === 12, '响应体是完整的 12 条');

const db = new DatabaseSync(process.env.AGENTMAKE_DB, { readOnly: true });
const logged = db.prepare("SELECT json FROM events WHERE type='http.body'").all().map((r) => JSON.parse(r.json));
db.close();
ok(logged.length >= 3 && logged.every((e) => e.body === '' && e.bytes > 0), '事件日志里只留字节数，正文不重复存（也不会推给每个页面）');

// ── 2 ──
console.log('\n[2] 连线上的真实数据量');
const f = await flowOf(a.pid);
ok(['loadHistory', 'analyze', 'polish', 'autoReply'].every((n) => step(f, n)), `★ 四个有名字的步骤：${f.steps.map((s) => s.label).join(' → ')}`);
const edge = f.edges.find((e) => e.from === step(f, 'loadHistory')?.id && e.to === step(f, 'analyze')?.id);
ok(edge?.data?.last?.items === 12 && edge?.data?.last?.used === 5, `★ 线上：12 条 → ${edge?.data?.last?.used} 条`);
ok(edge?.data?.dropped === 3 && edge?.data?.samples === 3, `★ 3 个请求里 ${edge?.data?.dropped} 次丢数据`);
ok(f.steps.every((s) => s.row !== undefined) && new Set(f.steps.map((s) => s.row)).size === 4, '并发的请求没有把步骤画成「同时进行」');

// ── 3 ──
console.log('\n[3] 规则判定与循环');
ok(step(f, 'autoReply')?.failing?.['rule.truncated'] === 3, '★ autoReply 节点上挂着「被截断 ×3」');
const polish = step(f, 'polish');
ok(!!polish?.loopId, 'polish 在循环里');
const reqs = (await j(`${AM}/api/runs?limit=500`)).filter((r) => r.parent_run_id === a.pid);
ok(reqs.length === 3, '3 个请求级运行');
const rf = await flowOf(reqs[0].run_id);
const iters = step(rf, 'polish')?.spans.map((s) => s.iteration);
ok(JSON.stringify(iters) === '[1,2,3]', `★ 每个请求自己从第 1 轮数起（实得 ${JSON.stringify(iters)}）`);
const loop = rf.loops.find((l) => l.id === polish.loopId);
ok(loop?.iterations === 3, '单个请求的循环转了 3 轮');

// ── 4 ──
console.log('\n[4] 异常栏');
const titles = f.anomalies.map((x) => `${x.title}(${x.count})`);
ok(f.anomalies.some((x) => x.kind === 'data_dropped' && x.count === '3/3 次'), `★ 报了「数据在进 prompt 前被丢掉 3/3」：${titles.join('、')}`);
ok(f.anomalies.some((x) => x.kind === 'rule' && x.title === '回答被截断'), '★ 报了「回答被截断」');
ok(f.anomalies[0].severity === 'fail', '结果已经错了的排在最前');
const dropAlert = f.anomalies.find((x) => x.kind === 'data_dropped');
ok(dropAlert.stepIds.length === 2 && dropAlert.callIds.length === 1, '异常带着相关步骤和典型调用 —— 页面点一下就能在图上定位');

const b = await agent({ FULL_HISTORY: '1', REPLY_TOKENS: '512' });
await b.send(44);
await b.stop();
const fixed = await flowOf(b.pid);
const fe = fixed.edges.find((e) => e.from === step(fixed, 'loadHistory')?.id);
ok(fe?.data?.last?.used === 12 && fe?.data?.dropped === 0, '修好之后：12 条 → 12 条');
ok(fixed.anomalies.length === 0, `★ 修好之后异常栏是空的（实得 ${fixed.anomalies.map((x) => x.title).join('、') || '无'}）`);

// ── 5. 追查 ──
console.log('\n[5] 追查：prompt 按来源拆开 + 跨请求对比');
// 41 / 42 有 12 条历史（会被 slice(-5) 丢掉带「投诉」的那几条）；50 只有 4 条（丢不掉，是对照组）
const c = await agent();
await c.send(41);
await c.send(50);
await c.send(42);
await c.stop();
const cf = await flowOf(c.pid);
const analyzeStep = step(cf, 'analyze');
const cmp = await j(`${AM}/api/steps/compare?runId=${c.pid}&stepId=${encodeURIComponent(analyzeStep.id)}`);
ok(cmp.rows.length === 3, '对比表：analyze 在 3 个请求里各一行');
ok(cmp.rows.filter((r) => r.input?.dropped).length === 2, '其中 2 行上游数据被丢掉');
ok(cmp.rows.every((r) => r.trigger === 'POST /tickets'), '每行标着是哪个入站请求');
ok(/被丢掉的 2 次：输出 「\{"priority":"normal"\}」2 次，下一步 「polish」2 次；没丢的 1 次：输出 「\{"priority":"urgent"\}」1 次，下一步 「escalate」1 次/.test(cmp.pattern ?? ''),
  `★ 规律：丢了数据的判 normal、走 polish；没丢的判 urgent、走 escalate`);

const dropRow = cmp.rows.find((r) => r.input?.dropped);
const an = await j(`${AM}/api/calls/${encodeURIComponent(dropRow.callId)}/anatomy`);
ok(an.parts.find((p) => p.key === 'system')?.segments[0]?.source === 'template', 'system 认出是源码里的模板');
ok(an.parts.some((p) => p.segments.some((s) => s.source === 'tool' && s.from === 'loadHistory' && s.items[0] >= 8)), '★ 消息标着「来自 loadHistory 第 8–12 条」');
ok(an.dropped[0]?.total === 12 && an.dropped[0]?.used === 5, '★ 没进 prompt：12 条里缺了 7 条');
ok(an.dropped[0]?.items.some((x) => /投诉/.test(x.text)) && an.dropped[0]?.items.some((x) => /律师/.test(x.text)), '缺的正是带「投诉」「律师」的那几条');
ok(an.suspects.length === 1 && /history\.slice\(-5\)/.test(an.suspects[0].code), `★ 可疑代码只指了一行：${an.suspects[0]?.file.split('/').pop()}:${an.suspects[0]?.line}`);

const { TOOLS } = await import('../src/mcp/tools.ts');
const tool = (n) => TOOLS.find((t) => t.name === n);
const ga = await tool('get_anomalies').run({ runId: c.pid });
ok(ga.includes('数据在进 prompt 前被丢掉') && ga.includes('2/3 次') && ga.includes('trace_prompt('), 'MCP get_anomalies：报出丢数据，并指向 trace_prompt');
const tp = await tool('trace_prompt').run({ callId: dropRow.callId });
ok(tp.includes('没进 prompt：loadHistory 给了 12 条，只用了 5 条') && tp.includes('history.slice(-5)'), '★ MCP trace_prompt：AI 看得到缺了什么、哪行丢的');
const cs = await tool('compare_step').run({ runId: c.pid, step: 'analyze' });
ok(cs.includes('★ 规律') && cs.includes('两组结果不一样'), 'MCP compare_step：AI 拿到规律');

// ── 6. 验证 ──
console.log('\n[6] 验证：修完之后批量回归 + 逐步对齐');
const bad = await agent();
await bad.send(41);
await bad.send(42);
await bad.send(50);
await bad.stop();
const badReqs = (await j(`${AM}/api/runs?limit=500`)).filter((r) => r.parent_run_id === bad.pid);
ok(badReqs.length === 3 && badReqs.every((r) => r.request_method === 'POST' && r.request_url === '/tickets' && JSON.parse(r.request_body).id),
  '★ 入站请求被探针记下来了（方法、路径、请求体）—— 回归要原样重发');

const good = await agent({ FULL_HISTORY: '1' }); // 改好的服务，带着探针跑着；故意不开 AGENTMAKE_REPLAY
const goodRow = (await j(`${AM}/api/runs?limit=500`)).find((r) => r.run_id === good.pid);
ok(JSON.parse(goodRow?.listen ?? '[]')[0]?.port > 0, '记下了改好的服务在监听哪个端口');

const started = await j(`${AM}/api/regress`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseline: bad.pid }),
});
ok(started.target === good.pid, `★ 自动找到了改好的服务（${started.target}）`);
let bt = started;
for (let i = 0; i < 100 && !bt.done; i++) { await sleep(200); bt = await j(`${AM}/api/regress/${started.id}`); }
ok(bt.done, '回归跑完了');
ok(bt.summary.fixed === 2 && bt.summary.ok === 1 && bt.summary.regressed === 0,
  `★ 原来出问题的 2 个都改对了，原来好的 1 个没变坏（实得 改对 ${bt.summary.fixed} / 没变坏 ${bt.summary.ok} / 改坏 ${bt.summary.regressed}）`);
const okItem = bt.items.find((x) => x.outcome === 'ok');
ok(okItem?.real === 0 && okItem?.replayed === 2, `★ 没受影响的那个请求全走缓存（真打 ${okItem?.real} / 缓存 ${okItem?.replayed}）—— 目标服务没开重放也照样省钱`);
const fixedItem = bt.items.find((x) => x.outcome === 'fixed');
ok(fixedItem?.changed[0] === '★ analyze', `注入点是 analyze（实得 ${fixedItem?.changed.join(' · ')}）`);

const v = await j(`${AM}/api/verify?b=${fixedItem.run}`);
ok(v.a === fixedItem.baseline, '★ 只给改后的运行，就精确对上了它重发自的那个基线请求');
ok(v.verdict === 'better' && v.fixed.some((x) => x.startsWith('数据在进 prompt 前被丢掉')), `结论：变好了（修好：${v.fixed.join('、')}）`);
const st = Object.fromEntries(v.pairs.map((p) => [p.label, p.status]));
ok(st.loadHistory === 'same' && st.analyze === 'changed' && st.polish === 'only_a' && st.escalate === 'only_b',
  `逐步对齐：${v.pairs.map((p) => `${p.star ? '★' : ''}${p.label}=${p.status}`).join(' ')}`);
const pa = v.pairs.find((p) => p.label === 'analyze');
const d = await j(`${AM}/api/verify/diff?a=${pa.a.callIds[0]}&b=${pa.b.callIds[0]}`);
ok(d.prompt.filter((x) => x.op === 'add').length === 7 && d.prompt.filter((x) => x.op === 'del').length === 0, '★ analyze 的 prompt 差异：正好多了被丢掉的那 7 条');
ok(d.output.some((x) => x.op === 'del' && x.text.includes('normal')) && d.output.some((x) => x.op === 'add' && x.text.includes('urgent')), '输出差异：normal → urgent');

const vr = await tool('verify_run').run({ runB: fixedItem.run, step: 'analyze' });
ok(vr.includes('✓ 变好了') && vr.includes('★ analyze') && vr.includes('+ user │'), 'MCP verify_run：结论、注入点、逐行差异');
const rr = await tool('run_regression').run({ baseline: bad.pid, only: 'failed', waitSeconds: 30 });
ok(rr.includes('原来出过问题的 2 个：2 个改对了'), 'MCP run_regression：AI 拿到批量结论');
await good.stop();

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
