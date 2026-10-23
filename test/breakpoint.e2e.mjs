// 断点端到端验证。
// 关键断言不是「页面上停住了」，而是 **改动真的到达了模型** ——
// 拿 mock 的 /__last 回显来证明，而不是相信我们自己的日志。

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = (u, o) => fetch(u, o).then((r) => r.json());

let failed = 0;
const ok = (cond, msg) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed++;
};

async function waitPending(timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const bp = await j(`${AM}/api/breakpoints`);
    if (bp.pending?.length) return bp.pending[0];
    await sleep(120);
  }
  return null;
}

const setBp = (p) =>
  j(`${AM}/api/breakpoints`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
  });

const resume = (callId, phase, d) =>
  j(`${AM}/api/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId, phase, ...d }),
  });

async function runAgent(script, env = {}) {
  const { spawn } = await import('node:child_process');
  const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
  const p = spawn(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  return { proc: p, done: new Promise((r) => p.on('exit', () => r(out))) };
}

// ── 场景 1：命中断点 → 改 system → 放行 → 模型收到改后的内容 ──
console.log('\n[1] 断点 + 改 prompt');
await j(`${AM}/api/breakpoints`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ llmBefore: true, once: true, node: null }),
});

const { spawn } = await import('node:child_process');
const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
const agent = spawn(process.execPath, [new URL('./one-call.mjs', import.meta.url).pathname], {
  env: { ...process.env, NODE_OPTIONS: `--import ${harness}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let agentOut = '';
agent.stdout.on('data', (d) => (agentOut += d));
agent.stderr.on('data', (d) => (agentOut += d));

const pending = await waitPending();
ok(!!pending, '调用被挂起（被调试进程正阻塞在闸门上）');

if (pending) {
  const before = await j(`${MOCK}/__last`).catch(() => null);
  ok(before === null || !JSON.stringify(before).includes('断点改过的系统提示'),
     '放行前模型还没收到任何东西');

  await j(`${AM}/api/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      callId: pending.callId,
      action: 'patch',
      patch: { system: '断点改过的系统提示', params: { temperature: 0.99 } },
    }),
  });
}

await new Promise((r) => agent.on('exit', r));
const sent = await j(`${MOCK}/__last`);
const sysMsg = sent?.messages?.find((m) => m.role === 'system');
ok(sysMsg?.content === '断点改过的系统提示', '★ 模型实际收到的是改后的 system');
ok(sent?.temperature === 0.99, '★ 参数改动也生效了');
ok(sent?.response_format?.type === 'json_object', '未编辑的字段原样透传（保守合并）');
ok(sent?.messages?.some((m) => m.role === 'user' && m.content === '原始用户消息'),
   '未编辑的用户消息未被破坏');
ok(agentOut.includes('agent-done'), '被调试进程正常跑完，未被弄坏');

// ── 场景 2：伪造响应 —— 模型不该被调用 ──
console.log('\n[2] 伪造响应');
const marker = 'MARK_' + Date.now();
await j(`${AM}/api/breakpoints`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ llmBefore: true, once: true }),
});
const a2 = spawn(process.execPath, [new URL('./one-call.mjs', import.meta.url).pathname], {
  env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, USER_MSG: marker },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out2 = '';
a2.stdout.on('data', (d) => (out2 += d));

const p2 = await waitPending();
if (p2) {
  await j(`${AM}/api/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId: p2.callId, action: 'fake', text: '这是伪造的回答' }),
  });
}
await new Promise((r) => a2.on('exit', r));
const sent2 = await j(`${MOCK}/__last`);
ok(!JSON.stringify(sent2).includes(marker), '★ 伪造时模型根本没被调用');
ok(out2.includes('这是伪造的回答'), '★ 用户代码拿到了伪造的响应，像真的一样');

// ── 场景 3：断点关闭时不拦截 ──
console.log('\n[3] 断点关闭');
await j(`${AM}/api/breakpoints`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ llmBefore: false }),
});
const t0 = Date.now();
const a3 = spawn(process.execPath, [new URL('./one-call.mjs', import.meta.url).pathname], {
  env: { ...process.env, NODE_OPTIONS: `--import ${harness}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out3 = '';
a3.stdout.on('data', (d) => (out3 += d));
await new Promise((r) => a3.on('exit', r));
ok(out3.includes('agent-done'), '正常跑完');
ok(Date.now() - t0 < 4000, `未被拦截，耗时 ${Date.now() - t0}ms`);

// ── 场景 4：响应后断点 —— 改模型的回答 ──
console.log('\n[4] 响应后断点：改模型的回答');
await setBp({ llmBefore: false, llmAfter: true, once: true });
const r4 = await runAgent('one-call.mjs');
const p4 = await waitPending();
ok(p4?.phase === 'llm.after', '停在 llm.after 阶段');
if (p4) await resume(p4.callId, 'llm.after', { action: 'replace', text: '被改写的模型回答' });
const out4 = await r4.done;
ok(out4.includes('被改写的模型回答'), '★ 用户代码拿到的是改写后的回答');
ok(!out4.includes('明白了'), '原始回答已被替换');

// ── 场景 5：工具断点 —— 伪造工具返回值 ──
console.log('\n[5] 工具断点：伪造返回值测异常分支');
await setBp({ llmAfter: false, httpBefore: true, once: true, urlContains: '/some/tool/api' });
await sleep(300); // 等 harness 从上报响应里拿到 httpArmed
const r5 = await runAgent('tool-call.mjs');
const p5 = await waitPending();
ok(p5?.phase === 'http.before', '停在 http.before 阶段');
if (p5) {
  await resume(p5.callId, 'http.before', {
    action: 'fake', status: 503, body: '{"error":"服务不可用"}',
  });
}
const out5 = await r5.done;
ok(out5.includes('status: 503'), '★ 用户代码看到的是伪造的 503');
ok(out5.includes('服务不可用'), '★ 伪造的响应体也生效了');
ok(out5.includes('tool-done'), '被调试进程正常跑完');

// ── 场景 6：单步 —— 放行后停在下一次 ──
console.log('\n[6] 单步：放行并停下一次');
await setBp({ httpBefore: false, urlContains: null, llmBefore: true, once: true });
const r6 = await runAgent('two-calls.mjs');
const s1 = await waitPending();
ok(!!s1, '停在第 1 次调用');
if (s1) {
  await j(`${AM}/api/resume`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callId: s1.callId, phase: 'llm.before', action: 'continue', armNext: true }),
  });
}
const s2 = await waitPending();
ok(!!s2 && s2.callId !== s1?.callId, '★ 自动停在第 2 次调用（单步生效）');
if (s2) await resume(s2.callId, 'llm.before', { action: 'continue' });
const out6 = await r6.done;
ok(out6.includes('two-done'), '两次调用都完成');

// ── 收尾：全部关掉，避免残留断点卡住后续进程 ──
await setBp({ llmBefore: false, llmAfter: false, httpBefore: false, httpAfter: false, once: false, urlContains: null });

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
