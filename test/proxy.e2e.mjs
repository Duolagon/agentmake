// 代理层端到端验证 —— 「可以解析任何 agent」这句话的证据。
//
// 关键断言不是「代理转发成功了」，而是：
//   · 一个**纯 Python**、完全不知道 AgentMake 存在的 agent，被完整看到
//   · 三种协议（OpenAI / Anthropic / Gemini）都被正确归一化
//   · 断点能真的把它阻塞住，改过的 prompt 真的到达了模型（拿 mock 回显作证）
//   · 伪造 / 中止 / 重放对非 Node 的 agent 一样生效
//   · 流程图上它有节点（没有调用栈也不能凭空消失）

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const UP = Buffer.from(MOCK).toString('base64url');
const P = `${AM}/p/x/${UP}`;

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

async function waitPending(timeoutMs = 10_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const bp = await j(`${AM}/api/breakpoints`);
    if (bp.pending?.length) return bp.pending[0];
    await sleep(100);
  }
  return null;
}

const post = (path, body, headers = {}) =>
  fetch(`${P}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

function runPython(env = {}) {
  return import('node:child_process').then(({ spawn }) => {
    const p = spawn('python3', [new URL('./py-agent.py', import.meta.url).pathname], {
      env: {
        ...process.env,
        OPENAI_BASE_URL: `${P}/v1`,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    return {
      proc: p,
      done: new Promise((r) => p.on('exit', (code) => r({ code, out, err }))),
    };
  });
}

// ── 1. 三种协议都认得 ──────────────────────────────────────

console.log('\n[1] 三种协议归一化');
{
  const RUN = 'run_proxy_protocols';
  const H = { 'x-agentmake-run': RUN };

  await post('/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'system', content: '你是校对助手' }, { role: 'user', content: '改写这句' }],
  }, H);

  await post('/v1/messages', {
    model: 'claude-opus-4',
    system: '你是审稿人',
    messages: [{ role: 'user', content: [{ type: 'text', text: '看看这段' }] }],
  }, { ...H, 'anthropic-version': '2023-06-01' });

  await post('/v1beta/models/gemini-2.5-pro:generateContent', {
    systemInstruction: { parts: [{ text: '你是助手' }] },
    contents: [{ role: 'user', parts: [{ text: '你好' }] }],
  }, { ...H, 'x-goog-api-key': 'k' });

  await sleep(400);
  const calls = await j(`${AM}/api/calls?runId=${RUN}`);
  ok(calls.length === 3, `捕获 3 次调用（实得 ${calls.length}）`);
  const provs = calls.map((c) => c.provider).sort();
  ok(
    JSON.stringify(provs) === JSON.stringify(['anthropic', 'gemini', 'openai']),
    `★ 三种协议都被识别：${provs.join(' / ')}`,
  );
  ok(calls.every((c) => c.ok === 1), '三次都成功转发到上游');

  const full = await Promise.all(calls.map((c) => j(`${AM}/api/calls/${c.call_id}`)));
  const systems = full.map((c) => c.system).sort();
  ok(
    JSON.stringify(systems) === JSON.stringify(['你是助手', '你是审稿人', '你是校对助手']),
    '★ system prompt 从三种不同的原生结构里被正确抽出来',
  );
  ok(full.every((c) => c.response_text), '响应文本也被归一化');
}

// ── 2. 纯 Python agent：断点 + 改 prompt ───────────────────

console.log('\n[2] 纯 Python agent 被断点阻塞，改动真的到达模型');
{
  const RUN = 'run_proxy_python';
  await setBp({ llmBefore: true, llmAfter: false, once: true });
  const { done } = await runPython({ AGENTMAKE_RUN: RUN });

  const pending = await waitPending();
  ok(!!pending, '★ Python 进程被阻塞在断点上（它完全不知道 AgentMake 存在）');
  ok(pending?.phase === 'llm.before', `阶段 = ${pending?.phase}`);

  const before = await j(`${AM}/api/calls/${pending.callId}`);
  ok(before.system === '你是选题助手', '暂停中就能读到即将发出的 system prompt');

  const MARK = '你是被 AgentMake 改过的选题助手';
  const r = await resume(pending.callId, 'llm.before', { action: 'patch', patch: { system: MARK } });
  ok(r.ok, '放行成功');

  const res = await done;
  ok(res.code === 0 && res.out.includes('py-done'), `Python 正常跑完（退出码 ${res.code}）`);

  await sleep(400);
  const calls = await j(`${AM}/api/calls?runId=${RUN}`);
  ok(calls.length === 2, `记录到 2 次调用（实得 ${calls.length}）`);

  const patched = await j(`${AM}/api/calls/${calls[0].call_id}`);
  ok(patched.system === MARK, '★★ 库里存的是**改写后**实际发出去的 prompt，不是改之前的');
  ok(calls[0].patched === 1, '被标记为已改写');
}

// ── 3. 伪造响应：Python 侧拿到的是我们造的内容 ──────────────

console.log('\n[3] 伪造响应（不真的打模型）');
{
  const RUN = 'run_proxy_fake';
  const before = await j(`${MOCK}/__count`);
  await setBp({ llmBefore: true, once: true });

  const p = post('/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: '随便' }],
  }, { 'x-agentmake-run': RUN });

  const pending = await waitPending();
  ok(!!pending, '停住了');
  await resume(pending.callId, 'llm.before', { action: 'fake', text: '这是伪造的答案' });

  const body = await (await p).json();
  ok(
    body.choices?.[0]?.message?.content === '这是伪造的答案',
    '★ 客户端拿到的是伪造内容（原生 OpenAI 结构，SDK 解得开）',
  );
  const after = await j(`${MOCK}/__count`);
  ok(after.llm === before.llm, `★ 模型一次都没被调用（${before.llm} → ${after.llm}）`);

  await sleep(300);
  const calls = await j(`${AM}/api/calls?runId=${RUN}`);
  ok(calls[0]?.faked === 1, '这次调用被标记为伪造');
}

// ── 4. 中止：错误抛回给客户端 ──────────────────────────────

console.log('\n[4] 中止调用');
{
  const RUN = 'run_proxy_abort';
  await setBp({ llmBefore: true, once: true });
  const p = post('/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }],
  }, { 'x-agentmake-run': RUN });

  const pending = await waitPending();
  await resume(pending.callId, 'llm.before', { action: 'abort', message: '故意中止' });

  const res = await p;
  ok(!res.ok, `客户端收到错误响应（HTTP ${res.status}）`);
  const body = await res.json();
  ok(String(body.error?.message).includes('故意中止'), '★ 错误消息透传给了客户端代码');
}

// ── 5. 改写模型的回答 ──────────────────────────────────────

console.log('\n[5] 改写模型的回答（测下游怎么处理异常输出）');
{
  const RUN = 'run_proxy_replace';
  await setBp({ llmBefore: false, llmAfter: true, once: true });
  const p = post('/v1/chat/completions', {
    model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }],
  }, { 'x-agentmake-run': RUN });

  const pending = await waitPending();
  ok(pending?.phase === 'llm.after', `停在 ${pending?.phase}`);
  await resume(pending.callId, 'llm.after', { action: 'replace', text: '{"坏":"格式"}' });

  const body = await (await p).json();
  ok(
    body.choices?.[0]?.message?.content === '{"坏":"格式"}',
    '★ 客户端拿到的是被改写的回答，模型真调了但结果被我们换掉',
  );
  await setBp({ llmAfter: false, once: false });
}

// ── 6. 重放：不花钱重跑 ────────────────────────────────────

console.log('\n[6] 重放（非 Node 的 agent 也能用）');
{
  const BASE = 'run_proxy_replay_base';
  const REPLAY = 'run_proxy_replay_2';
  const payload = { model: 'gpt-4o', messages: [{ role: 'user', content: '重放我' }] };

  await post('/v1/chat/completions', payload, { 'x-agentmake-run': BASE });
  await sleep(300);

  const before = await j(`${MOCK}/__count`);
  const res = await post('/v1/chat/completions', payload, {
    'x-agentmake-run': REPLAY,
    'x-agentmake-replay': BASE,
  });
  const body = await res.json();
  ok(!!body.choices?.[0]?.message?.content, '客户端拿到了响应');
  const after = await j(`${MOCK}/__count`);
  ok(after.llm === before.llm, `★ 输入没变 → 模型没被调用（${before.llm} → ${after.llm}）`);

  await sleep(300);
  const calls = await j(`${AM}/api/calls?runId=${REPLAY}`);
  ok(calls[0]?.replayed === 1, '标记为重放');

  // 改了输入就该穿透缓存
  const before2 = await j(`${MOCK}/__count`);
  await post('/v1/chat/completions',
    { model: 'gpt-4o', messages: [{ role: 'user', content: '换了内容' }] },
    { 'x-agentmake-run': REPLAY, 'x-agentmake-replay': BASE });
  const after2 = await j(`${MOCK}/__count`);
  ok(after2.llm === before2.llm + 1, '★ 输入变了 → 穿透缓存，真的打了模型');
}

// ── 7. 流程图上必须有它 ────────────────────────────────────

console.log('\n[7] 没有调用栈也要出现在流程图上');
{
  const flow = await j(`${AM}/api/flow?runId=run_proxy_python`);
  ok(flow.steps.length >= 2, `流程图有 ${flow.steps.length} 个步骤`);
  ok(flow.steps.every((s) => s.source === 'proxy'), '标注为代理来源（提示用户没有调用栈）');
  const labels = flow.steps.map((s) => s.label);
  ok(
    labels.some((l) => l.includes('审稿人')) && labels.some((l) => l.includes('选题助手')),
    `★ 按 system prompt 分出了语义步骤：${labels.join(' / ')}`,
  );
  ok(flow.steps.every((s) => s.preview?.in && s.preview?.out), '每个步骤都带输入输出摘要');
}

// ── 8. 非 LLM 请求照样透传 ─────────────────────────────────

console.log('\n[8] 非 LLM 请求原样透传');
{
  const res = await fetch(`${P}/feed/1`);
  const text = await res.text();
  ok(res.ok && text.includes('fixture payload'), '普通 GET 被正确转发并拿回响应');
}

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
