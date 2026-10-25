// 通用性端到端：不管 agent 用什么方式调模型，都看得见、能重放、断点能用。
//
//   [1] Node 各种写法（node:http 具名导入 / gzip / 读流、http.get 工具、fetch 读四种协议的流、Responses API）
//       带探针跑，用户代码拿到的结果和不带探针一字不差；每次调用都记下来了，流式的拼回了完整回答
//   [2] 重放：模型一次都没被调用，用户拿到的（包括一段一段读的流）一字不差
//   [3] node:http 上的断点：改写请求（content-length 跟着改）、伪造回答（根本不发请求）
//   [4] Python：aiohttp（普通 / 读流 / 工具）+ 官方 openai SDK 的流式（以前完全看不见）—— 需要装了依赖的解释器
//   [5] Python：urllib / requests 拿到的二进制响应和不带探针一模一样（以前按 UTF-8 解码再编码，字节被改坏）
//   [6] fetch(new Request(url, {body}))：prompt 记得下来、断点改写生效
//   [7] 读完流式回答立刻 abort 自己的 signal（dsh 的收尾方式）：回答完整，不被误判成失败
//   [8] 子进程：记着是谁拉起的、挂在父运行（或那次请求）下面、归进同一组；AGENTMAKE_CHILDREN=0 时子进程不带探针

import { spawn, spawnSync } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
const pyHarness = new URL('../src/pyharness', import.meta.url).pathname;
const here = (f) => new URL(`./${f}`, import.meta.url).pathname;

async function run(cmd, args, env = {}) {
  const before = new Set((await j(`${AM}/api/runs?limit=500`)).map((r) => r.run_id));
  const p = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => p.on('exit', r));
  await sleep(800);
  const runId = (await j(`${AM}/api/runs?limit=500`)).find((r) => !before.has(r.run_id))?.run_id ?? null;
  const result = out.match(/^RESULT (.*)$/m)?.[1] ?? null;
  return { code, out, runId, result };
}
const node = (file, env = {}, probe = true) => run(process.execPath, [here(file)], probe ? { NODE_OPTIONS: `--import ${harness}`, ...env } : env);
const callsOf = async (rid) => Promise.all(
  (await j(`${AM}/api/calls?runId=${rid}`)).map((c) => j(`${AM}/api/calls/${encodeURIComponent(c.call_id)}`)),
);
const count = () => j(`${MOCK}/__count`);

// ── 1 ──
console.log('\n[1] Node：各种调模型的写法');
const plain = await node('client-agent.mjs', {}, false);
const a = await node('client-agent.mjs');
ok(a.code === 0 && a.result, `带探针正常跑完${a.code ? `（退出码 ${a.code}）\n${a.out.slice(-600)}` : ''}`);
ok(a.result === plain.result, '★ 用户代码拿到的结果和不带探针一字不差（拦截不改变任何行为）');
const ca = await callsOf(a.runId);
const llm = ca.filter((c) => c.kind === 'llm');
ok(llm.length === 10, `10 次模型调用都记下来了（实得 ${llm.length}）`);
const kinds = new Set(llm.map((c) => c.provider));
ok(['openai', 'anthropic', 'gemini', 'openai_responses'].every((k) => kinds.has(k)), `★ 四种协议都认出来了：${[...kinds].join(' / ')}`);
const streams = llm.filter((c) => c.streaming);
ok(streams.length === 5 && streams.every((c) => (c.response_text ?? '').includes('流式回答') || (c.response_text ?? '').includes('你好')),
  `★ 5 次流式调用都拼回了完整回答（不再是空的）`);
ok(llm.some((c) => c.provider === 'openai' && c.streaming && JSON.parse(c.messages ?? '[]').some((m) => m.content === 'stream')), 'node:http 读流的那次也在（axios responseType=stream 的形状）');
ok(llm.filter((c) => c.provider === 'openai' && !c.streaming).length === 2, 'node:http 的普通调用和 gzip 那次都在，gzip 的回答被解开了');
const fc = llm.find((c) => c.provider === 'openai_responses' && c.response_tool_calls);
ok(JSON.parse(fc?.response_tool_calls ?? '[]')[0]?.name === 'get_weather', '★ Responses API 的工具调用认出来了');
const r2 = llm.find((c) => c.provider === 'openai_responses' && /根据工具结果/.test(c.response_text ?? ''));
ok(JSON.parse(r2?.messages ?? '[]').some((m) => m.toolResults?.[0]?.content === '{"weather":"晴"}') && r2?.system === '你会查天气',
  'Responses API 送回去的工具结果、instructions 都归一化了');
const tool = ca.find((c) => c.kind === 'http' && String(c.url).includes('/feed/clients'));
ok(tool?.response_body === 'fixture payload for /feed/clients', 'http.get 调的工具：响应体也记下来了');
ok(!llm.some((c) => c.failing), '没有被误判成失败的调用（流式以前会被误报「空输出」）');

// ── 2 ──
console.log('\n[2] 重放');
await fetch(`${MOCK}/__reset`);
const b = await node('client-agent.mjs', { AGENTMAKE_REPLAY: a.runId });
const n = await count();
ok(n.llm === 0, `★ 模型一次都没被调用（实得 ${n.llm} 次）—— node:http、fetch、流式全部命中缓存`);
ok(b.result === plain.result, '★ 用户代码拿到的一字不差（流式的被原样回放成流）');
const cb = (await callsOf(b.runId)).filter((c) => c.kind === 'llm');
ok(cb.length === 10 && cb.every((c) => c.replayed), '10 次都标成了重放');

// ── 3 ──
console.log('\n[3] node:http 上的断点');
const armOnce = () => fetch(`${AM}/api/breakpoints`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ llmBefore: true, once: true }) });
async function pausedCall() {
  for (let i = 0; i < 50; i++) {
    const p = (await j(`${AM}/api/breakpoints`)).pending?.[0];
    if (p) return p.callId;
    await sleep(100);
  }
  return null;
}
const resume = (callId, d) => fetch(`${AM}/api/resume`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId, phase: 'llm.before', ...d }) });

await armOnce();
const p1 = node('http-one-call.mjs');
const c1 = await pausedCall();
ok(!!c1, 'node:http 的调用停在了断点上');
await resume(c1, { action: 'patch', patch: { system: '断点里改过的系统提示，比原来长很多很多很多' } });
const r1 = await p1;
const last = await j(`${MOCK}/__last`);
ok(r1.out.includes('http-one-call-done') && last.messages[0].content === '断点里改过的系统提示，比原来长很多很多很多',
  '★ 改写生效：模型收到的是改过的系统提示（content-length 跟着改了，请求没坏）');

await armOnce();
await fetch(`${MOCK}/__reset`);
const p2 = node('http-one-call.mjs');
const c2 = await pausedCall();
await resume(c2, { action: 'fake', text: '断点上编的回答' });
const r2b = await p2;
ok(r2b.out.includes('answer: 断点上编的回答') && (await count()).llm === 0, '★ 伪造生效：用户代码拿到编的回答，模型根本没被调用');

// ── 4 ──
console.log('\n[4] Python：aiohttp + httpx 流式');
const py = process.env.AGENTMAKE_PY_DEPS || process.env.AGENTMAKE_PY_HTTPX || 'python3';
const hasDeps = spawnSync(py, ['-c', 'import aiohttp, openai'], { stdio: 'ignore' }).status === 0;
if (!hasDeps) {
  console.log(`  ⊘ 跳过：${py} 没装 aiohttp / openai。设 AGENTMAKE_PY_DEPS 指向装了它们的解释器`);
} else {
  const pyRun = (env = {}, probe = true) => run(py, [here('py-aiohttp-agent.py')], probe ? { PYTHONPATH: pyHarness, ...env } : env);
  const pp = await pyRun({}, false);
  const pa = await pyRun();
  ok(pa.code === 0 && pa.result === pp.result, `带探针跑完，用户代码拿到的结果一字不差${pa.code ? `\n${pa.out.slice(-800)}` : ''}`);
  const pc = await callsOf(pa.runId);
  const pl = pc.filter((c) => c.kind === 'llm');
  ok(pl.length === 5, `5 次模型调用都记下来了（aiohttp 2 + openai SDK 3；实得 ${pl.length}）`);
  ok(pl.filter((c) => c.streaming && (c.response_text ?? '').includes('流式回答')).length === 3,
    '★ 3 次流式都看得见、拼回了完整回答（aiohttp 按行读流 · SDK 同步流 · SDK 异步流）');
  ok(pc.some((c) => c.kind === 'http' && c.response_body === 'fixture payload for /feed/aio'), 'aiohttp 调的工具：响应体也记下来了');
  await fetch(`${MOCK}/__reset`);
  const pb = await pyRun({ AGENTMAKE_REPLAY: pa.runId });
  ok((await count()).llm === 0 && pb.result === pp.result, '★ 重放：模型一次都没被调用，aiohttp 和 SDK 读到的流一字不差');
}

// ── 5 ──
console.log('\n[5] Python：二进制响应原样透传（只用标准库，不需要额外依赖）');
{
  const py3 = process.env.AGENTMAKE_PY_DEPS || 'python3';
  const bin = (probe) => run(py3, [here('py-binary-agent.py')], probe ? { PYTHONPATH: pyHarness } : {});
  const plainBin = await bin(false);
  const probedBin = await bin(true);
  const got = JSON.parse(probedBin.result ?? '{}');
  ok(got.urllib?.[0] === 512 && probedBin.result === plainBin.result,
    `★ urllib（以及装了的话 requests）读到的字节和不带探针一模一样${probedBin.result !== plainBin.result ? `\n  无探针 ${plainBin.result}\n  有探针 ${probedBin.result}` : ''}`);
}

// ── 6 ──
console.log('\n[6] fetch(Request)：请求体在 Request 对象上');
{
  const r6 = await node('request-obj-agent.mjs');
  const c6 = (await callsOf(r6.runId)).find((c) => c.kind === 'llm');
  ok(r6.out.includes('request-obj-done') && c6?.system === 'Request 对象里的系统提示',
    `★ 记下来的 prompt 是 Request 里的那份（以前是空的）${r6.out.includes('request-obj-done') ? '' : `\n${r6.out.slice(-500)}`}`);

  await armOnce();
  const p6 = node('request-obj-agent.mjs');
  const c6b = await pausedCall();
  await resume(c6b, { action: 'patch', patch: { system: '断点里改过的（Request 形态）' } });
  const r6b = await p6;
  const last6 = await j(`${MOCK}/__last`);
  ok(r6b.out.includes('request-obj-done') && last6.messages[0].content === '断点里改过的（Request 形态）',
    '★ 断点改写在 Request 形态上也真的生效（以前会被原对象里的 body 盖回去或静默失败）');
}

// ── 7 ──
console.log('\n[7] 读完流就 abort 自己的 signal（dsh 的写法）');
{
  const r7 = await node('stream-abort-agent.mjs');
  const c7 = (await callsOf(r7.runId)).find((c) => c.kind === 'llm');
  ok(r7.out.includes('stream-abort-done') && c7 && !c7.error && !c7.failing && (c7.response_text ?? '').includes('流式回答'),
    `★ 回答完整、不算失败（以前记成「流在中途断了」，dsh 的每次调用都被判失败）${c7?.error ? `：${c7.error}` : ''}`);
}

// ── 8 ──
console.log('\n[8] 子进程：挂在父运行下面 · AGENTMAKE_CHILDREN=0 关掉继承');
{
  const allRuns = () => j(`${AM}/api/runs?limit=2000`);
  const before = new Set((await allRuns()).map((r) => r.run_id));
  const py3 = process.env.AGENTMAKE_PY_DEPS || 'python3';
  const r8 = await node('spawn-agent.mjs', { PYTHONPATH: pyHarness, AGENTMAKE_PY_DEPS: py3 });
  await sleep(500);
  const fresh = (await allRuns()).filter((r) => !before.has(r.run_id));
  const parent = fresh.find((r) => r.kind === 'process' && String(r.argv).includes('spawn-agent.mjs'));
  const reqRun = fresh.find((r) => r.kind === 'request' && r.parent_run_id === parent?.run_id);
  const kids = fresh.filter((r) => r.spawned_by);
  const byArg = (a) => kids.find((r) => String(r.argv).includes(a));
  ok(r8.out.includes('spawn-agent-done') && parent && !parent.spawned_by, `父进程正常跑完、自己不是谁的子进程${r8.out.includes('spawn-agent-done') ? '' : `\n${r8.out.slice(-600)}`}`);
  ok(byArg('exec-child')?.spawned_by === parent?.run_id, '★ execFile 拉起的 node 子进程记着是谁拉起的它');
  ok(kids.some((r) => String(r.argv).includes('-c') && r.run_id.startsWith('run_py') && r.spawned_by === parent?.run_id), '★ spawnSync 拉起的 python 子进程也挂在父运行下面');
  ok(!!reqRun && byArg('request-child')?.spawned_by === reqRun.run_id, '★ 处理请求时拉起的子进程记到那次请求上（dsh 某一轮对话里跑的命令）');
  ok(kids.length === 4 && kids.every((k) => k.group_id === parent?.group_id), `子进程都归进父运行的组（${kids.length} 个）`);
  ok(kids.filter((k) => !String(k.argv).includes('noop-child')).every((k) => k.call_count >= 1), '子进程的模型调用照样记下来了');
  ok(!fresh.some((r) => r.trigger === 'POST /noop') && byArg('noop-child')?.spawned_by === parent?.run_id,
    '★ 没调过模型的请求里拉起子进程：不冒出空的请求级运行，子进程记到进程上'); 

  const before2 = new Set((await allRuns()).map((r) => r.run_id));
  const r8b = await node('spawn-agent.mjs', { PYTHONPATH: pyHarness, AGENTMAKE_PY_DEPS: py3, AGENTMAKE_CHILDREN: '0' });
  await sleep(500);
  const fresh2 = (await allRuns()).filter((r) => !before2.has(r.run_id));
  ok(r8b.out.includes('spawn-agent-done') && fresh2.length >= 1 && !fresh2.some((r) => r.spawned_by) && fresh2.every((r) => !String(r.argv).includes('-child')),
    `★ AGENTMAKE_CHILDREN=0：只有父进程被记录，子进程一个都没报（新运行 ${fresh2.length} 个，都是父进程自己的）`);
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
