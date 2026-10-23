// 工具调用端到端：模型调工具 → 代码执行 → 结果回给模型。
//
// 要证明三件事：
//   1. 只调工具、没有正文的回答，库里也看得到它调了什么、传了什么参数
//   2. 回给模型的工具结果是结构化的（callId + 内容），不是一个占位符
//   3. 重放：工具结果没变 → 全部命中；工具结果变了 → 第二次调用穿透缓存

import { spawn } from 'node:child_process';

const AM = 'http://127.0.0.1:8787';
const MOCK = 'http://127.0.0.1:8799';
const j = (u, o) => fetch(u, o).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parse = (s) => { try { return JSON.parse(s) ?? []; } catch { return []; } };

let failed = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failed++; };

const harness = new URL('../src/harness/register.ts', import.meta.url).pathname;

async function run(env = {}) {
  const p = spawn(process.execPath, [new URL('./tool-agent.mjs', import.meta.url).pathname], {
    env: { ...process.env, NODE_OPTIONS: `--import ${harness}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  await new Promise((r) => p.on('exit', r));
  await sleep(500);
  const runs = await j(`${AM}/api/runs`);
  const runId = runs[0]?.run_id;
  const list = (await j(`${AM}/api/calls?runId=${runId}`)).filter((c) => c.kind === 'llm');
  const calls = await Promise.all(list.map((c) => j(`${AM}/api/calls/${encodeURIComponent(c.call_id)}`)));
  return { runId, out, calls };
}

// ── 1. 基线 ──
console.log('\n[1] 工具调用进了 IR');
await fetch(`${MOCK}/__reset`);
const base = await run();
ok(base.out.includes('tool-agent-done'), '被调试进程正常跑完');
ok(base.calls.length === 2, `两次 LLM 调用（实得 ${base.calls.length}）`);

const [c0, c1] = base.calls;
const respCalls = parse(c0?.response_tool_calls);
ok(!c0?.response_text, '第一次回答没有正文（只调工具）');
ok(respCalls.length === 1 && respCalls[0].name === 'search_orders', '★ 看得到模型调了 search_orders');
ok(respCalls[0]?.args?.q === '订单 42 为什么延迟', '★ 参数已解析成对象，不是一串 JSON 字符串');
ok(/^call_/.test(respCalls[0]?.id ?? ''), '保留了调用 id');
ok(c0?.finish_reason === 'tool_calls', 'finish_reason = tool_calls');

const msgs = parse(c1?.messages);
const asst = msgs.find((m) => m.role === 'assistant');
const toolMsg = msgs.find((m) => m.role === 'tool');
ok(asst?.toolCalls?.[0]?.name === 'search_orders', '★ 第二次请求里，助手消息带着结构化的工具调用');
ok(toolMsg?.toolResults?.[0]?.callId === respCalls[0]?.id, '★ 工具结果对得上调用 id');
ok(toolMsg?.toolResults?.[0]?.content.includes('fixture payload'), '工具结果内容是真实返回值');
ok(!msgs[0]?.toolCalls && !msgs[0]?.toolResults, '纯文本消息不多出工具字段');

// ── 2. AI 侧看得到 ──
console.log('\n[2] MCP get_call');
{
  const { TOOLS } = await import('../src/mcp/tools.ts');
  const getCall = TOOLS.find((t) => t.name === 'get_call');
  const t0 = await getCall.run({ callId: c0.call_id });
  ok(t0.includes('【模型发起的工具调用】') && t0.includes('search_orders('), '★ 响应里的工具调用展示给 AI');
  const t1 = await getCall.run({ callId: c1.call_id });
  ok(t1.includes('↳ 调用工具 search_orders') && t1.includes('↳ 工具结果'), '★ 消息里的调用和结果都展示给 AI');
}

// ── 3. 重放 ──
console.log('\n[3] 工具结果不变的重放');
await fetch(`${MOCK}/__reset`);
const same = await run({ AGENTMAKE_REPLAY: base.runId });
ok((await j(`${MOCK}/__count`)).llm === 0, '★ 两次调用全部命中缓存，模型没被调用');
ok(same.out.includes('tool-agent-done'), '被调试进程拿到缓存的工具调用，照常跑完');

console.log('\n[4] 工具结果变了的重放');
await fetch(`${MOCK}/__reset`);
const changed = await run({ AGENTMAKE_REPLAY: base.runId, TOOL_SUFFIX: '（库存已更新）' });
ok((await j(`${MOCK}/__count`)).llm === 1, '★ 第一次命中，第二次因工具结果变了而穿透缓存');
ok(changed.calls[0]?.replayed === 1 && changed.calls[1]?.replayed === 0, '重放标记对得上');

const cmp = await j(`${AM}/api/compare?a=${base.runId}&b=${changed.runId}`);
ok(cmp.divergeAt === 1, `★ 分歧点定位在第 1 次调用（实得 ${cmp.divergeAt}）`);
ok(cmp.pairs[1]?.snippet?.b?.includes('库存已更新'), '★ 差异片段指向工具结果，而不是一个占位符');
ok(cmp.pairs[0]?.responseSame === true, '第 0 次：重放的工具调用与基线相同');

console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过');
process.exit(failed ? 1 : 0);
