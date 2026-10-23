// MCP server 端到端。自己当 MCP 客户端说 JSON-RPC，验证协议握手与每个工具。
import { spawn } from 'node:child_process';

const server = spawn(process.execPath, [new URL('../src/mcp/server.ts', import.meta.url).pathname], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env },
});

let stderr = '';
server.stderr.on('data', (d) => (stderr += d));

// ── 极简 JSON-RPC 客户端 ──
let nextId = 1;
const waiting = new Map();
let buf = '';
server.stdout.setEncoding('utf8');
server.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const w = waiting.get(msg.id);
    if (w) { waiting.delete(msg.id); w(msg); }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    waiting.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => { waiting.delete(id); reject(new Error(`${method} 超时`)); }, 15000);
  });
}
const notify = (method, params) =>
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);

const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  return { text: r.result?.content?.[0]?.text ?? '', isError: !!r.result?.isError };
};

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

// ── 协议握手 ──
console.log('\n[协议]');
const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'test', version: '0' },
});
ok(init.result?.serverInfo?.name === 'agentmake', 'initialize 返回 serverInfo');
ok(init.result?.protocolVersion === '2025-06-18', '回声客户端的 protocolVersion');
ok(!!init.result?.capabilities?.tools, '声明了 tools 能力');
notify('notifications/initialized');

const pong = await rpc('ping', {});
ok(pong.result && !pong.error, 'ping 有响应');

const list = await rpc('tools/list', {});
const names = (list.result?.tools ?? []).map((t) => t.name);
ok(names.length >= 10, `tools/list 返回 ${names.length} 个工具`);
ok(names.includes('get_call') && names.includes('find_failures'), '核心工具都在');
ok(
  (list.result.tools ?? []).every((t) => t.description && t.inputSchema?.type === 'object'),
  '每个工具都有 description 和 inputSchema',
);

// ── 只读工具 ──
console.log('\n[感官]');
// 先跑一个有函数层级的 agent，后面的断言都针对它 —— 用「最近一次运行」会不稳定
const runId = await runNested();
ok(!!runId, `拿到 runId: ${runId ?? '无'}`);

const runs = await call('list_runs', { limit: 5 });
ok(!runs.isError && runs.text.includes('run_'), 'list_runs 成功');

const calls = await call('list_calls', { runId, limit: 20 });
ok(!calls.isError && calls.text.includes('call_'), 'list_calls 返回调用列表');
const callId = (calls.text.match(/(call_[\w]+)/) ?? [])[1];

if (callId) {
  const detail = await call('get_call', { callId });
  ok(!detail.isError, 'get_call 成功');
  ok(detail.text.includes('调用路径'), '★ 详情含调用路径（哪个函数发起的）');
  ok(/SYSTEM PROMPT|MESSAGE|GET |POST /.test(detail.text), '★ 详情含实际发出的内容');

}

// 截断只对长文本字段（prompt / 响应）有意义，必须挑一次 LLM 调用来验
const llmList = await call('list_calls', { runId, kind: 'llm' });
const llmId = (llmList.text.match(/(call_[\w]+)/) ?? [])[1];
if (llmId) {
  const full = await call('get_call', { callId: llmId, maxChars: 4000 });
  const clipped = await call('get_call', { callId: llmId, maxChars: 10 });
  ok(clipped.text.includes('已截断') && clipped.text.length < full.text.length,
     '★ maxChars 生效（token 预算控制）');
}

const graph = await call('get_graph', { runId });
ok(!graph.isError && /个函数/.test(graph.text), 'get_graph 返回函数统计');
ok(/实际发起调用的函数/.test(graph.text), 'get_graph 列出发起调用的函数及源码位置');
ok(/orchestrate → gather/.test(graph.text), '★ 推导出真实的调用关系链');

// 顶层直接发起的调用（脚本式 agent）也必须出现在图里，不能被匿名帧过滤掉
const topRun = await runScript('one-call.mjs');
if (topRun) {
  const g3 = await call('get_graph', { runId: topRun });
  ok(/1 次 LLM/.test(g3.text), '★ 模块顶层发起的调用没有从图里消失');
  ok(/one-call\.mjs/.test(g3.text), '顶层帧用文件名显示，而不是 <top>');
}

// 函数声明而非 const —— 上面第一个断言就要用它，箭头函数会踩 TDZ
function runNested() { return runScript('nested-agent.mjs'); }

async function runScript(script) {
  const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
  const p = spawn(process.execPath, [new URL(`./${script}`, import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}` }, stdio: 'ignore',
  });
  await new Promise((r) => p.on('exit', r));
  await new Promise((r) => setTimeout(r, 500));
  const rs = await call('list_runs', { limit: 1 });
  return (rs.text.match(/^(run_\w+)/m) ?? [])[1] ?? null;
}

const search = await call('search_calls', { query: '系统' });
ok(!search.isError, 'search_calls 成功');

const fails = await call('find_failures', {});
ok(!fails.isError, 'find_failures 成功');

const attach = await call('get_attach_command', {});
ok(attach.text.includes('NODE_OPTIONS') && attach.text.includes('register.ts'), 'get_attach_command 给出可用命令');

// ── 控制面 ──
console.log('\n[手]');
const set = await call('set_breakpoint', { llmBefore: true, once: true });
ok(!set.isError && set.text.includes('llmBefore'), 'set_breakpoint 生效');

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;
const agent = spawn(process.execPath, [new URL('./one-call.mjs', import.meta.url).pathname], {
  env: { ...process.env, NODE_OPTIONS: `--import ${harness}` },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let agentOut = '';
agent.stdout.on('data', (d) => (agentOut += d));

let pausedId = null;
for (let i = 0; i < 40 && !pausedId; i++) {
  const p = await call('list_paused');
  pausedId = (p.text.match(/(call_[\w]+)/) ?? [])[1] ?? null;
  if (!pausedId) await new Promise((r) => setTimeout(r, 200));
}
ok(!!pausedId, '★ list_paused 看到被阻塞的调用');

if (pausedId) {
  const before = await call('get_call', { callId: pausedId });
  ok(before.text.includes('原始系统提示'), '暂停中就能读到即将发出的 prompt');

  const r = await call('resume', {
    callId: pausedId, phase: 'llm.before', action: 'patch',
    patch: { system: 'MCP-PATCHED' },
  });
  ok(!r.isError && r.text.includes('已放行'), 'resume 成功');
}

await new Promise((r) => agent.on('exit', r));
const sent = await fetch('http://127.0.0.1:8799/__last').then((r) => r.json());
ok(sent.messages?.find((m) => m.role === 'system')?.content === 'MCP-PATCHED',
   '★★ AI 通过 MCP 改的 prompt 真的到达了模型');
ok(agentOut.includes('agent-done'), '被调试进程正常跑完');

// ── 错误处理 ──
console.log('\n[健壮性]');
const bad = await call('get_call', { callId: 'call_不存在' });
ok(bad.isError, '工具失败返回 isError 而不是断掉协议');
const unknown = await rpc('tools/call', { name: 'no_such_tool', arguments: {} });
ok(!!unknown.error, '未知工具返回协议错误');

await call('set_breakpoint', { llmBefore: false, llmAfter: false, httpBefore: false, httpAfter: false });
server.kill();
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
if (stderr && process.env.SHOW_STDERR) console.log('stderr:', stderr);
process.exit(failed ? 1 : 0);
