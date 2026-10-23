// Python harness 端到端验证 —— 「Python agent 和 Node agent 能力对齐」的证据。
//
// 和 proxy.e2e 的分工：代理层证明「任何语言都看得见、控得住」，但它没有调用栈。
// 这一套要证明 Python 侧拿到了代理层给不了的东西：
//   · 真实的 file:line 调用栈（执行图能定位到是哪个函数、哪一行发的）
//   · 循环插桩：轮次可见、运行中改上限、立即跳出
// 外加断点/伪造/中止/改写/重放这些和 Node 对齐的能力。

import { spawn } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const PYPATH = new URL('../src/pyharness', import.meta.url).pathname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u, o) => fetch(u, o).then((r) => r.json());

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

const setBp = (p) =>
  j(`${AM}/api/breakpoints`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
  });

const resume = (callId, phase, d) =>
  j(`${AM}/api/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId, phase, ...d }),
  });

const setLoop = (loopId, o) =>
  j(`${AM}/api/loops`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId, ...o }),
  });

async function waitPending(timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const bp = await j(`${AM}/api/breakpoints`);
    if (bp.pending?.length) return bp.pending[0];
    await sleep(100);
  }
  return null;
}

// httpx 不一定装了（openai/anthropic SDK 才带它）。装了就测，没装就明说跳过 ——
// 静默跳过等于假装测过了。AGENTMAKE_PY_HTTPX 指到一个装了 httpx 的解释器即可。
const PY_HTTPX = process.env.AGENTMAKE_PY_HTTPX || 'python3';

function hasHttpx() {
  return new Promise((r) => {
    const p = spawn(PY_HTTPX, ['-c', 'import httpx'], { stdio: 'ignore' });
    p.on('exit', (c) => r(c === 0));
    p.on('error', () => r(false));
  });
}

/** 跑一个 Python 固定件。asModule=true 走 `-m agentmake`（入口脚本要循环插桩时必须） */
function runPy(script, env = {}, asModule = false, exe = 'python3') {
  const path = new URL(`./${script}`, import.meta.url).pathname;
  const args = asModule ? ['-m', 'agentmake', path] : [path];
  const p = spawn(exe, args, {
    env: { ...process.env, PYTHONPATH: PYPATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  return { proc: p, done: new Promise((r) => p.on('exit', (code) => r({ code, out, err }))) };
}

const LOOP_ID = new URL('./py-loop-agent.py', import.meta.url).pathname + ':25';

// ── 1. 零改动接入 + 调用栈 ─────────────────────────────────

console.log('\n[1] 纯 Python agent 零改动接入，且拿到真实调用栈');
{
  const RUN = 'run_py_e2e_nested';
  const r = await (await runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: RUN })).done;
  ok(r.code === 0 && r.out.includes('nested-done'), `Python 正常跑完（退出码 ${r.code}）${r.err.slice(0, 300)}`);
  await sleep(600);

  const flow = await j(`${AM}/api/flow?runId=${RUN}`);
  ok(flow.totals.llm === 1 && flow.totals.tool === 3, `1 次 LLM + 3 次工具（实得 ${flow.totals.llm}/${flow.totals.tool}）`);
  ok(
    flow.steps.every((s) => s.source === 'harness'),
    '★ 标为 harness 来源 —— 有调用栈，不是代理那种降级模式',
  );

  const labels = flow.steps.map((s) => s.label).sort();
  ok(
    JSON.stringify(labels) === JSON.stringify(['compose', 'scout_one']),
    `★ 步骤取到了 Python 的函数名：${labels.join(' / ')}`,
  );
  ok(
    flow.steps.every((s) => s.file.endsWith('.py') && s.line > 0),
    '★ 每一步都定位到了 .py 文件和行号',
  );

  const compose = flow.steps.find((s) => s.label === 'compose');
  ok(compose.preview.in.includes('总结以下 3 条材料'), '节点上看得到实际发出的 prompt');
  ok(compose.model === 'deepseek-chat', `模型名从请求体里抽出来了：${compose.model}`);

  const calls = await j(`${AM}/api/calls?runId=${RUN}`);
  const llm = calls.find((c) => c.kind !== 'http');
  const full = await j(`${AM}/api/calls/${llm.call_id}`);
  ok(full.system === '你是摘要助手', '★ system prompt 被正确归一化（OpenAI 协议里它混在 messages 中）');
}

// ── 2. 断点阻塞 Python + 改 prompt ─────────────────────────

console.log('\n[2] 断点把 Python 进程阻塞住，改动真的到达模型');
{
  const RUN = 'run_py_e2e_bp';
  await setBp({ llmBefore: true, llmAfter: false, once: true });
  const { done } = runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: RUN });

  const pending = await waitPending();
  ok(!!pending, '★ Python 进程被阻塞在断点上');
  ok(pending?.phase === 'llm.before', `阶段 = ${pending?.phase}`);
  ok(
    (pending?.frames ?? []).some((f) => f.fn === 'compose'),
    `★ 暂停时就知道是哪个函数发的：${(pending?.frames ?? []).map((f) => f.fn).join(' → ')}`,
  );

  const MARK = '你是被 AgentMake 改过的摘要助手';
  await resume(pending.callId, 'llm.before', { action: 'patch', patch: { system: MARK } });

  const r = await done;
  ok(r.code === 0, `Python 正常跑完（退出码 ${r.code}）`);
  await sleep(600);

  const last = await j(`${MOCK}/__last`);
  const sysMsg = (last?.messages ?? []).find((m) => m.role === 'system');
  ok(sysMsg?.content === MARK, '★★ 改动真的到达了模型（拿 mock 的回显作证）');

  const calls = await j(`${AM}/api/calls?runId=${RUN}`);
  const llm = calls.find((c) => c.kind !== 'http');
  ok(llm?.patched === 1, '库里标记为已改写');
  const full = await j(`${AM}/api/calls/${llm.call_id}`);
  ok(full.system === MARK, '★ 库里存的是改写后实际发出去的那一份');
}

// ── 3. 伪造 / 中止 / 改写回答 ──────────────────────────────

console.log('\n[3] 伪造响应（模型不被调用）');
{
  const RUN = 'run_py_e2e_fake';
  const before = await j(`${MOCK}/__count`);
  await setBp({ llmBefore: true, once: true });
  const { done } = runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: RUN });

  const pending = await waitPending();
  await resume(pending.callId, 'llm.before', { action: 'fake', text: '这是伪造的摘要' });

  const r = await done;
  ok(r.out.includes('这是伪造的摘要'), '★ Python 代码拿到的是伪造内容（原生 OpenAI 结构，它自己解得开）');
  const after = await j(`${MOCK}/__count`);
  ok(after.llm === before.llm, `★ 模型一次都没被调用（${before.llm} → ${after.llm}）`);
}

console.log('\n[4] 中止调用 —— 错误抛进 Python 代码');
{
  const RUN = 'run_py_e2e_abort';
  await setBp({ llmBefore: true, once: true });
  const { done } = runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: RUN });

  const pending = await waitPending();
  await resume(pending.callId, 'llm.before', { action: 'abort', message: '故意中止' });

  const r = await done;
  ok(r.code !== 0, `Python 以非零退出（${r.code}）`);
  ok(r.err.includes('故意中止'), '★ 中止消息作为异常抛进了用户代码，能测它的错误分支');
}

console.log('\n[5] 改写模型的回答');
{
  const RUN = 'run_py_e2e_replace';
  await setBp({ llmBefore: false, llmAfter: true, once: true });
  const { done } = runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: RUN });

  const pending = await waitPending();
  ok(pending?.phase === 'llm.after', `停在 ${pending?.phase}`);
  await resume(pending.callId, 'llm.after', { action: 'replace', text: '{"坏":"格式"}' });

  const r = await done;
  ok(r.out.includes('{"坏":"格式"}'), '★ 模型真调了，但 Python 代码拿到的是我们换掉的回答');
  await setBp({ llmAfter: false, once: false });
}

// ── 6. 重放 ────────────────────────────────────────────────

console.log('\n[6] 重放 —— 不花钱重跑');
{
  const BASE = 'run_py_e2e_replay_base';
  await (await runPy('py-nested-agent.py', { AGENTMAKE_RUN_ID: BASE })).done;
  await sleep(600);

  const before = await j(`${MOCK}/__count`);
  const r = await (await runPy('py-nested-agent.py', {
    AGENTMAKE_RUN_ID: 'run_py_e2e_replay_2',
    AGENTMAKE_REPLAY: BASE,
  })).done;
  ok(r.code === 0, '重放跑完');
  const after = await j(`${MOCK}/__count`);
  ok(after.llm === before.llm, `★ 输入没变 → 模型没被调用（${before.llm} → ${after.llm}）`);

  await sleep(600);
  const calls = await j(`${AM}/api/calls?runId=run_py_e2e_replay_2`);
  ok(calls.some((c) => c.replayed === 1), '标记为重放');
}

// ── 7. 循环：代理层给不了的能力 ────────────────────────────

console.log('\n[7] 循环插桩：轮次可见 + 运行中改上限 + 立即跳出');
{
  await setLoop(LOOP_ID, { maxIterations: null, breakNow: false, breakpoint: false });

  const RUN = 'run_py_e2e_loop_base';
  const r = await (await runPy('py-loop-agent.py', { AGENTMAKE_RUN_ID: RUN, LOOP_MAX: '5' }, true)).done;
  ok(r.out.includes('rounds=5'), `基线：循环自然跑满 5 轮（源码里 MAX=5）${r.err.slice(0, 200)}`);
  await sleep(600);

  const flow = await j(`${AM}/api/flow?runId=${RUN}`);
  ok(flow.loops.length === 1, `发现 1 个循环（实得 ${flow.loops.length}）`);
  ok(flow.loops[0].iterations === 5, `★ 轮次可见：${flow.loops[0].iterations} 轮`);
  ok(
    JSON.stringify(flow.steps[0].iterations) === JSON.stringify([1, 2, 3, 4, 5]),
    '★ 每次调用归属到了具体第几轮（逐轮查看的基础）',
  );

  await setLoop(LOOP_ID, { maxIterations: 2 });
  const r2 = await (await runPy('py-loop-agent.py', { AGENTMAKE_RUN_ID: 'run_py_e2e_loop_max', LOOP_MAX: '5' }, true)).done;
  ok(r2.out.includes('rounds=2'), `★ 上限实时改成 2，用户代码自己打印 ${r2.out.trim()}（没改代码）`);

  const f2 = await j(`${AM}/api/flow?runId=run_py_e2e_loop_max`);
  ok(f2.loops[0]?.exitReason === 'max_override', `退出原因标成 max_override（实得 ${f2.loops[0]?.exitReason}）`);

  await setLoop(LOOP_ID, { maxIterations: null });
  const r3 = await (await runPy('py-loop-agent.py', { AGENTMAKE_RUN_ID: 'run_py_e2e_loop_reset', LOOP_MAX: '5' }, true)).done;
  ok(r3.out.includes('rounds=5'), '清掉覆写后恢复源码行为');
}

console.log('\n[8] 每轮暂停 + 中途跳出');
{
  await setLoop(LOOP_ID, { breakpoint: true });
  const { done } = runPy('py-loop-agent.py', { AGENTMAKE_RUN_ID: 'run_py_e2e_loop_break', LOOP_MAX: '9' }, true);

  // 等它停在某一轮的边界上
  let seen = null;
  for (let i = 0; i < 60 && !seen; i++) {
    const d = await j(`${AM}/api/loops`);
    const flow = await j(`${AM}/api/flow?runId=run_py_e2e_loop_break`);
    if (flow.loops[0]?.pausedAt) seen = flow.loops[0].pausedAt;
    else await sleep(150);
    void d;
  }
  ok(!!seen, `★ 循环停在轮次边界上（第 ${seen} 轮）`);

  await j(`${AM}/api/loop-resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loopId: LOOP_ID, action: 'break' }),
  });

  const r = await done;
  const rounds = Number(/rounds=(\d+)/.exec(r.out)?.[1] ?? -1);
  ok(rounds > 0 && rounds < 9, `★ 中途跳出：源码要跑 9 轮，实际 ${rounds} 轮`);
  await setLoop(LOOP_ID, { breakpoint: false });
}

// ── 9. httpx：openai / anthropic / google-genai 的 SDK 都走它 ──

console.log('\n[9] httpx（同步 + 异步并发）');
if (await hasHttpx()) {
  const RUN = 'run_py_e2e_httpx';
  const r = await (await runPy('py-httpx-agent.py', { AGENTMAKE_RUN_ID: RUN }, false, PY_HTTPX)).done;
  ok(r.code === 0 && r.out.includes('httpx-done'), `跑完（退出码 ${r.code}）${r.err.slice(0, 300)}`);
  await sleep(700);

  const flow = await j(`${AM}/api/flow?runId=${RUN}`);
  ok(flow.totals.llm === 4, `★ 同步 1 次 + 异步并发 3 次都被捕获（实得 ${flow.totals.llm}）`);
  ok(
    flow.steps.every((s) => s.source === 'harness'),
    '★ 异步路径也拿到了调用栈 —— 钩子跑在线程池里，帧必须在协程自己的栈上先抓好',
  );
  ok(flow.steps.every((s) => s.file.endsWith('.py')), '每一步都定位到了 .py 文件');
  ok(
    flow.steps.some((s) => s.concurrency > 1),
    '★ 异步并发被识别出来（说明钩子没有把事件循环冻住，三条协程真的在并行）',
  );
} else {
  console.log(`  ⊘ 跳过：${PY_HTTPX} 没装 httpx。装了再跑，或设 AGENTMAKE_PY_HTTPX 指向带 httpx 的解释器`);
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
