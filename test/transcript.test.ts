// 完整记录：把一次次「整段对话」的调用还原成一条不重复的对话时间线。
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLoopMap, buildTiming, buildTranscript, toolFailed, type TranscriptCall } from '../src/server/transcript.ts';

let t = 1000;
const call = (extra: Partial<TranscriptCall>): TranscriptCall => ({
  call_id: `c${t}`, run_id: 'r', kind: 'llm', model: 'm', url: 'https://api.x/v1/messages', method: 'POST',
  status: 200, ok: 1, error: null, system: 'You are an agent', messages: '[]', response_text: null,
  response_tool_calls: null, finish_reason: 'end_turn', duration_ms: 100, input_tokens: 10, output_tokens: 5,
  cache_read_tokens: null, started_at: t++, response_preview: null, response_bytes: null,
  ...extra,
});
const J = JSON.stringify;
const TASK = { role: 'user', content: '测试当前服务有没有 bug' };
const bash = (id: string, command: string) => ({ id, name: 'bash', args: { command } });

/** dsh 的形状：每轮发整段对话；回传历史时助手消息的写法和原始回答不一样（带工具块占位） */
function agentLoop(): TranscriptCall[] {
  return [
    call({ call_id: 'a1', messages: J([TASK]), response_text: '先看看目录', response_tool_calls: J([bash('t1', 'ls -la')]), finish_reason: 'tool_use' }),
    call({ call_id: 'title', system: 'Create a concise title', messages: J([{ role: 'user', content: '给这段对话起个标题' }]), response_text: '服务测试' }),
    call({ kind: 'http', call_id: 'h1', model: null, url: 'https://example.com/feed', method: 'GET', response_preview: '[1,2]', response_bytes: 5 }),
    call({
      call_id: 'a2',
      messages: J([TASK,
        { role: 'assistant', content: '先看看目录«toolUse bash»', toolCalls: [bash('t1', 'ls -la')] },
        { role: 'user', content: '«toolResult»', toolResults: [{ callId: 't1', name: null, content: 'total 8\nREADME.md' }] }]),
      response_text: '看完了，没有问题',
    }),
  ];
}

test('★ 还原成对话：任务一次；工具结果挂回发起它的那一轮（命令和结果在一起）；上一轮的回答不重复', () => {
  const tr = buildTranscript(agentLoop());
  assert.equal(tr.task?.text, '测试当前服务有没有 bug');
  const rounds = tr.items.filter((i) => i.kind === 'llm' && !i.side) as any[];
  assert.deepEqual(rounds.map((r) => r.round), [1, 2]);
  assert.deepEqual(rounds[0].input, [], '第一轮的用户消息就是任务，不再重复');
  assert.deepEqual(rounds[0].reply.toolCalls, [{ name: 'bash', args: '{"command":"ls -la"}' }]);
  assert.deepEqual(rounds[0].results, [{ name: 'bash', text: 'total 8\nREADME.md' }], '结果挂在发起 ls 的第 1 轮，工具名按调用 id 补上');
  assert.deepEqual(rounds[1].input, [], '第二轮没有新的用户消息（工具结果已经挪走，上一轮的回答不重复）');
  assert.equal(rounds[1].reply.text, '看完了，没有问题');
});

test('旁路调用（换了 system prompt）单独一行，不打断主线的轮次；HTTP 请求按时间插在中间', () => {
  const tr = buildTranscript(agentLoop());
  assert.deepEqual(tr.items.map((i) => i.kind === 'llm' ? (i.side ? 'side' : `round${i.round}`) : i.kind), ['round1', 'side', 'http', 'round2']);
  const side = tr.items[1] as any;
  assert.equal(side.thread, 'Create a concise title');
  assert.equal(side.reply.text, '服务测试');
  assert.equal(tr.llm, 3);
  assert.equal(tr.tool, 1);
});

test('框架拼在用户消息后面的运行时上下文拆出来折起；进行中的调用标成进行中', () => {
  const tr = buildTranscript([
    call({ messages: J([{ role: 'user', content: '测试服务Current runtime context. cwd=/x' }]), duration_ms: null, ok: null, response_text: null, finish_reason: null }),
  ]);
  assert.equal(tr.task?.text, '测试服务');
  assert.equal(tr.task?.context, 'Current runtime context. cwd=/x');
  assert.equal((tr.items[0] as any).pending, true);
});

test('接不上之前的对话（上下文被压缩重写）标出来，那一轮的输入整段显示', () => {
  const tr = buildTranscript([
    call({ messages: J([TASK]), response_text: '第一轮' }),
    call({ messages: J([{ role: 'user', content: '（前面的对话已压缩）摘要……' }]), response_text: '接着干' }),
  ]);
  const r2 = tr.items[1] as any;
  assert.equal(r2.restart, true);
  assert.equal(r2.input[0].text, '（前面的对话已压缩）摘要……');
});

test('很长的工具结果截断并标记（完整的点进那一轮看）', () => {
  const long = 'x'.repeat(10_000);
  const tr = buildTranscript([
    call({ messages: J([TASK]), response_tool_calls: J([bash('t1', 'cat big')]) }),
    call({ messages: J([TASK, { role: 'assistant', content: '', toolCalls: [bash('t1', 'cat big')] }, { role: 'user', content: '«toolResult»', toolResults: [{ callId: 't1', name: null, content: long }] }]) }),
  ]);
  const res = (tr.items[0] as any).results[0];
  assert.equal(res.truncated, true);
  assert.equal(res.text.length, 4000);
});

// ── 时序：一轮一行，两轮之间的空档 = 工具执行 ──

test('★ 时序：每轮的开始、模型耗时，以及到下一轮之前的工具执行时间（卡住的那段看得见）', () => {
  const T = 1_000_000;
  const calls = [
    call({ call_id: 'r1', started_at: T, duration_ms: 3800, messages: J([TASK]), response_tool_calls: J([bash('a', 'ls -la'), bash('b', 'pwd')]) }),
    call({ call_id: 'title', started_at: T, duration_ms: 2000, system: 'Create a concise title', messages: J([{ role: 'user', content: '起标题' }]), response_text: '服务测试' }),
    call({ call_id: 'r2', started_at: T + 4100, duration_ms: 2800, messages: J([TASK, { role: 'assistant', content: '', toolCalls: [bash('a', 'ls -la'), bash('b', 'pwd')] }, { role: 'user', content: '«toolResult»', toolResults: [{ callId: 'a', name: null, content: 'ok' }] }]),
      response_tool_calls: J([bash('c', 'node ui-xss.mjs')]) }),
    call({ call_id: 'r3', started_at: T + 4100 + 2800 + 120_000, duration_ms: 2800, messages: J([TASK, { role: 'assistant', content: '', toolCalls: [bash('a', 'ls -la'), bash('b', 'pwd')] }, { role: 'user', content: '«toolResult»', toolResults: [{ callId: 'a', name: null, content: 'ok' }] }, { role: 'assistant', content: '', toolCalls: [bash('c', 'node ui-xss.mjs')] }, { role: 'user', content: '«toolResult»', toolResults: [{ callId: 'c', name: null, content: 'timeout' }] }]),
      response_text: '浏览器测试卡住了' }),
  ];
  const tm = buildTiming(buildTranscript(calls), { live: false, now: 0 });
  assert.deepEqual(tm.rows.map((r) => [r.kind, r.round, r.start, r.gap]), [
    ['round', 1, 0, 300],
    ['side', null, 0, null],
    ['round', 2, 4100, 120_000],
    ['round', 3, 126_900, null],
  ]);
  assert.equal(tm.rows[0].label, 'bash ×2');
  assert.equal(tm.rows[2].label, 'bash node ui-xss.mjs', '只有一个工具就写它的命令');
  assert.equal(tm.rows[3].label, '作答', '不调工具的那一轮在作答');
  assert.equal(tm.modelMs, 3800 + 2800 + 2800, '旁路不算进主线的模型时间');
  assert.equal(tm.toolMs, 120_300);
  assert.equal(tm.span, 126_900 + 2800);
});

test('时序：最后一轮发起了工具、进程还在 —— 工具正在执行，空档算到现在', () => {
  const calls = [call({ started_at: 1000, duration_ms: 500, messages: J([TASK]), response_tool_calls: J([bash('a', 'npm test')]) })];
  const live = buildTiming(buildTranscript(calls), { live: true, now: 11_500 });
  assert.equal(live.rows[0].gap, 10_000);
  assert.equal(live.rows[0].gapRunning, true);
  const done = buildTiming(buildTranscript(calls), { live: false, now: 11_500 });
  assert.equal(done.rows[0].gap, null, '进程已经不在了：不知道工具跑了多久，不瞎画');
});

test('时序标签：参数太长被截断成不合法的 JSON，也能抠出命令', async () => {
  const { argBrief } = await import('../src/server/transcript.ts');
  assert.equal(argBrief(String.raw`{"command":"cat > .qa/ui-xss.mjs <<'EOF'\nimport { chromium } from`), `cat > .qa/ui-xss.mjs <<'EOF' import { chromium } from`);
  assert.equal(argBrief('{"path":"/a/b.txt"}'), '/a/b.txt');
});

// ── 循环图 ──

test('★ 循环图：每个工具调了几次、失败几次（记在发起它的那一轮）、花了多久；最后一轮不调工具就是结论', () => {
  const T = 5_000_000;
  const ctx = (n: number) => {
    const msgs: any[] = [TASK];
    const cmds = ['ls', 'npm test', 'cat x'];
    for (let i = 0; i < n; i++) {
      msgs.push({ role: 'assistant', content: '', toolCalls: [bash(`t${i}`, cmds[i])] });
      msgs.push({ role: 'user', content: '«toolResult»', toolResults: [{ callId: `t${i}`, name: null, content: i === 1 ? 'FAIL\n[exit code: 1]' : 'ok\n[exit code: 0]' }] });
    }
    return J(msgs);
  };
  const calls = [
    call({ call_id: 'r1', started_at: T, duration_ms: 1000, messages: ctx(0), response_tool_calls: J([bash('t0', 'ls')]) }),
    call({ call_id: 'r2', started_at: T + 1500, duration_ms: 1000, messages: ctx(1), response_tool_calls: J([bash('t1', 'npm test')]) }),
    call({ call_id: 'r3', started_at: T + 32_500, duration_ms: 1000, messages: ctx(2), response_tool_calls: J([bash('t2', 'cat x')]) }),
    call({ call_id: 'r4', started_at: T + 34_000, duration_ms: 1000, messages: ctx(3), response_text: '## 结论\n**全部通过**，除了 npm test' }),
  ];
  const m = buildLoopMap(buildTranscript(calls));
  assert.equal(m.model.rounds, 4);
  assert.equal(m.tools.length, 1);
  const b = m.tools[0];
  assert.deepEqual([b.name, b.count, b.failed], ['bash', 3, 1]);
  assert.deepEqual(b.failedCallIds, ['r2'], '失败记在发起 npm test 的第 2 轮（命令和报错在同一处）');
  assert.equal(b.ms, 500 + 30_000 + 500, '每轮之后的空档就是工具在跑');
  assert.deepEqual(b.callIds, ['r1', 'r2', 'r3']);
  assert.equal(b.last?.args, 'cat x');
  assert.equal(m.final?.callId, 'r4');
  assert.equal(m.final?.text, '结论 全部通过，除了 npm test', '去掉 Markdown 符号');
  assert.equal(m.running, false);
});

test('失败只认框架写的退出码标记：输出正文里随口出现的「exited with code 1」不算', () => {
  assert.equal(toolFailed({ text: 'boom\n[exit code: 2]' }), true);
  assert.equal(toolFailed({ text: 'Daemon process exited with code 1\n…\n[exit code: 0]' }), false);
  assert.equal(toolFailed({ text: 'Daemon process exited with code 1' }), false);
  assert.equal(toolFailed({ text: 'x', isError: true }), true);
});
