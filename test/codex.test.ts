// Codex 接入：会话记录（~/.codex/sessions/*.jsonl）→ AgentMake 的运行和调用。
// 用一份手写的会话记录（形状照 Codex 0.164 实际写出来的），不依赖本机装没装 Codex。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexThread, startCodexWatcher, turnRunId } from '../src/server/codex.ts';
import { argBrief, categorize, toolFailed } from '../src/server/transcript.ts';
import { cleanTask, splitInjected } from '../src/server/history.ts';

const T0 = Date.parse('2026-10-25T03:00:00Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const meta = (id: string, extra: Record<string, unknown> = {}) => ({
  timestamp: iso(0), type: 'session_meta',
  payload: { id, timestamp: iso(0), cwd: '/work/proj', originator: 'Codex Desktop', base_instructions: 'You are Codex.', ...extra },
});
const at = (s: number) => ({ internal_chat_message_metadata_passthrough: { create_time: (T0 + s * 1000) / 1000 } });
const user = (s: number, text: string) => ({
  timestamp: iso(s), type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: { create_time: (T0 + s * 1000) / 1000, content_item_kinds: ['user.text'] } },
});
const say = (s: number, text: string, phase = 'commentary') => ({
  timestamp: iso(s), type: 'response_item',
  payload: { type: 'message', role: 'assistant', phase, content: [{ type: 'output_text', text }], ...at(s) },
});
const exec = (s: number, id: string, cmd: string) => ({
  timestamp: iso(s), type: 'response_item',
  payload: { type: 'custom_tool_call', name: 'exec', call_id: id, input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}}); text(r)`, ...at(s) },
});
const out = (s: number, id: string, code: number) => ({
  timestamp: iso(s), type: 'response_item',
  payload: { type: 'custom_tool_call_output', call_id: id, ...at(s),
    output: [{ type: 'input_text', text: 'Script completed\nWall time 0.1 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ chunk_id: 'x', exit_code: code, output: code ? 'boom' : 'ok' }) }] },
});
const usage = (s: number, i: number, o: number) => ({
  timestamp: iso(s), type: 'token_usage_record', payload: { usage: { input_tokens: i, cached_input_tokens: 100, output_tokens: o } },
});
const reasoning = (s: number) => ({ timestamp: iso(s), type: 'response_item', payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAA' } });
const started = (s: number, turn: string, parentTurn: string | null = null) => ({
  timestamp: iso(s), type: 'event_msg',
  payload: { type: 'task_started', turn_id: turn, started_at: (T0 + s * 1000) / 1000, turn_attribution: { turn_id: turn, parent_turn_id: parentTurn } },
});
const done = (s: number) => ({ timestamp: iso(s), type: 'event_msg', payload: { type: 'task_complete', completed_at: (T0 + s * 1000) / 1000 } });

const MAIN = [
  meta('thread-main'),
  { timestamp: iso(1), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
  started(1, 'turn-aaaa-0001'),
  { timestamp: iso(1), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>…' }] } },
  user(2, '<in-app-browser-context source="ambient">\nurl\n</in-app-browser-context>\n\n## My request:\n查一下测试为什么挂'),
  reasoning(3),
  say(4, '先跑一下测试看看。'),
  exec(5, 'call_1', 'npm test'),
  usage(5, 1000, 50),
  out(9, 'call_1', 1),
  reasoning(10),
  usage(11, 1200, 10), // 只想了一下、什么都没发（在等异步结果）
  exec(12, 'call_2', 'rg -n "boom" src'),
  usage(12, 1300, 30),
  out(13, 'call_2', 0),
  say(15, '原因是 boom。', 'final_answer'),
  usage(15, 1400, 80),
  done(16),
].map((o) => JSON.stringify(o));

const feedAll = (t: CodexThread, lines: string[]) => t.feed(lines);

test('Codex 会话 → 一个会话运行 + 每轮一个请求级运行，一次模型回答一次调用', () => {
  const evs = feedAll(new CodexThread('/x/rollout-thread-main.jsonl'), MAIN) as any[];
  const runs = evs.filter((e) => e.type === 'run.started');
  assert.equal(runs.length, 2);
  assert.deepEqual([runs[0].runId, runs[0].kind, runs[0].argv], ['codex_thread-main', 'process', ['codex', 'desktop']]);
  assert.equal(runs[1].runId, turnRunId('thread-main', 'turn-aaaa-0001'));
  assert.equal(runs[1].kind, 'request');
  assert.equal(runs[1].parentRunId, 'codex_thread-main');

  const before = evs.filter((e) => e.type === 'llm.before');
  const after = evs.filter((e) => e.type === 'llm.after');
  assert.equal(before.length, 4);
  assert.deepEqual(after.map((a) => a.response.finishReason), ['tool_calls', 'reasoning_only', 'tool_calls', 'stop']);
  assert.equal(before[0].request.model, 'gpt-6.1-sol');
  assert.equal(before[0].request.system, 'You are Codex.');
  // 第一次：说了一句话 + 发起 npm test；token 来自紧跟着的 token_usage_record
  assert.equal(after[0].response.text, '先跑一下测试看看。');
  assert.equal(after[0].response.toolCalls[0].name, 'exec');
  assert.deepEqual(after[0].response.usage, { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 100 });
  // 时间：从用户消息（2s）到发起工具（5s）
  assert.equal(before[0].ts, T0 + 2000);
  assert.equal(after[0].durationMs, 3000);
  // 输入是这一轮到此为止的对话：后一次以前一次为前缀（完整记录据此还原成一轮一轮）
  const m3 = before[2].request.messages;
  assert.equal(m3[0].role, 'user');
  assert.match(m3[0].content, /查一下测试为什么挂/);
  assert.equal(m3[1].toolCalls[0].id, 'call_1');
  assert.equal(m3[2].toolResults[0].callId, 'call_1');
  assert.ok(toolFailed({ text: m3[2].toolResults[0].content }), 'exit_code 1 算失败');
  assert.ok(!toolFailed({ text: before[3].request.messages.at(-1).toolResults[0].content }), 'exit_code 0 不算');
  // 这一轮结束
  const ended = evs.filter((e) => e.type === 'run.ended');
  assert.deepEqual(ended.map((e) => e.runId), [runs[1].runId]);
});

test('Codex：重启后重读同一个文件，已入库的运行和调用不再发', () => {
  const first = feedAll(new CodexThread('/x/a.jsonl'), MAIN) as any[];
  const calls = new Set(first.filter((e) => e.type === 'llm.before').map((e) => e.callId));
  const ends = new Map(first.filter((e) => e.type === 'run.ended').map((e) => [e.runId, e.ts]));
  const runs = new Set(first.filter((e) => e.type === 'run.started').map((e) => e.runId));
  const again = feedAll(new CodexThread('/x/a.jsonl', {
    call: (id) => calls.has(id),
    run: (id) => (ends.has(id) ? ends.get(id) : runs.has(id) ? null : undefined),
  }), MAIN);
  assert.deepEqual(again, []);
});

test('Codex 子 agent：跳过开头复制的父会话历史，挂在拉起它的那一轮下面，调用记在它自己的运行上', () => {
  const parentTurn = turnRunId('thread-main', 'turn-aaaa-0001');
  const lines = [
    meta('thread-sub', { parent_thread_id: 'thread-main', agent_nickname: 'Laplace', subagent_history_start_ordinal: 4 }),
    meta('thread-main'), // 复制过来的父会话
    started(0, 'turn-aaaa-0001'),
    say(0.5, '这是父会话说过的话'),
    // ↓ 从第 4 行起是它自己的
    started(20, 'turn-bbbb-0002', 'turn-aaaa-0001'),
    { timestamp: iso(20), type: 'response_item', payload: { type: 'agent_message', author: '/root', content: [{ type: 'input_text', text: '去查 src' }] } },
    exec(22, 'call_s1', 'ls src'),
    usage(22, 500, 20),
    out(23, 'call_s1', 0),
    say(25, '查完了', 'final_answer'),
    usage(25, 600, 20),
    done(26),
  ].map((o) => JSON.stringify(o));

  const known = { call: () => false, run: (id: string) => (id === parentTurn ? 123 : undefined) };
  const evs = new CodexThread('/x/sub.jsonl', known).feed(lines) as any[];
  const runs = evs.filter((e) => e.type === 'run.started');
  assert.equal(runs.length, 1, '子 agent 不按轮切开');
  assert.equal(runs[0].runId, 'codex_thread-sub');
  assert.equal(runs[0].spawnedBy, parentTurn);
  assert.deepEqual(runs[0].argv, ['codex', '子agent·Laplace']);
  const before = evs.filter((e) => e.type === 'llm.before');
  assert.equal(before.length, 2);
  assert.ok(before.every((b) => b.runId === 'codex_thread-sub'));
  assert.ok(!JSON.stringify(before).includes('父会话说过的话'), '复制段不进来');
  assert.match(before[0].request.messages[0].content, /去查 src/);

  // 拉起它的那一轮不在库里（父会话自己也是子 agent，不按轮切）：挂父会话本身
  const fallback = new CodexThread('/x/sub.jsonl').feed(lines) as any[];
  assert.equal(fallback.find((e) => e.type === 'run.started').spawnedBy, 'codex_thread-main');
});

test('Codex 跟随：写到一半的行留着下次拼上，新内容接着读', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'am-codex-'));
  try {
    mkdirSync(path.join(dir, '2026/10/25'), { recursive: true });
    const file = path.join(dir, '2026/10/25/rollout-x.jsonl');
    const text = `${MAIN.join('\n')}\n`;
    const cut = text.indexOf('npm test') + 3; // 切在一行中间
    writeFileSync(file, text.slice(0, cut));
    const got: any[] = [];
    const stop = startCodexWatcher({ record: (e) => got.push(e), known: { call: () => false, run: () => undefined } }, { dir, days: 1, pollMs: 30 });
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(got.filter((e) => e.type === 'llm.before').length, 0, '半行不解析');
    appendFileSync(file, text.slice(cut));
    await new Promise((r) => setTimeout(r, 200));
    stop();
    assert.equal(got.filter((e) => e.type === 'llm.before').length, 4);
    assert.equal(new Set(got.filter((e) => e.type === 'llm.before').map((e) => e.callId)).size, 4, '不重复');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex 的工具参数和输出：摘要抠出命令、按命令归类、退出码判失败', () => {
  const args = JSON.stringify({ input: 'const r = await tools.exec_command({cmd:"rg -n \\"boom\\" src", yield_time_ms:1000}); text(r)' });
  assert.equal(argBrief(args), 'rg -n "boom" src');
  assert.equal(categorize('exec', args), 'read');
  assert.equal(categorize('exec', JSON.stringify({ input: 'await tools.exec_command({cmd:"npm test"})' })), 'test');
  assert.equal(categorize('exec', JSON.stringify({ input: 'nodeRepl.write(1)' })), 'exec');
  assert.equal(argBrief(JSON.stringify({ code: 'await tab.click()', title: '点登录' })), '点登录');
  assert.ok(toolFailed({ text: 'Script failed\nWall time 0.1 seconds' }));
  assert.ok(toolFailed({ text: '{"chunk_id":"a","exit_code":0}\n{"chunk_id":"b","exit_code":128}' }), '以最后一个为准');
  assert.ok(!toolFailed({ text: 'Script completed\n{"exit_code":0,"output":"exited with code 1"}' }));
});

test('任务原文：去掉拼在前面的界面状态块', () => {
  const t = '<in-app-browser-context source="ambient-ui-state">\nThis block…\n</in-app-browser-context>\n\n## My request:\nSheerID 要准备什么？';
  assert.equal(cleanTask(t), 'SheerID 要准备什么？');
  assert.match(splitInjected(t).context ?? '', /in-app-browser-context/);
  // 整条都是标签块（Codex 的环境说明）：不拆，原样留着
  assert.equal(splitInjected('<environment_context>x</environment_context>').context, null);
});
