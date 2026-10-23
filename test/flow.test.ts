// buildFlow 的单元测试：从「调用 + 循环事件」推导 agent 语义流程。
//
// 这里守的是几条容易回归的推导规则：
//   步骤身份取**调用者**那一帧（不是最内层的通用封装）
//   轮次靠 seq 把循环事件和调用交错还原
//   分支只在「已跑完的轮」里判断
//   并发看时间区间重叠，且要求实质重叠（毫秒精度会造出假重叠）

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFlow } from '../src/server/flow.ts';
import type { CallRow, LoopEvent } from '../src/server/flow.ts';

const F = '/app/agent.mjs';
const LOOP = `${F}:10`;

let seq = 0;
function call(o: Partial<CallRow> & { fn: string; line: number }): CallRow {
  return {
    call_id: `c${++seq}`,
    seq,
    kind: 'llm',
    provider: 'openai',
    model: 'gpt',
    url: 'https://api/x',
    method: 'POST',
    // 最内层是通用封装 callModel —— 步骤身份不该落在它身上
    frames: JSON.stringify([
      { file: F, fn: '<top>', line: 1 },
      { file: F, fn: o.fn, line: o.line },
      { file: F, fn: 'callModel', line: 3 },
    ]),
    system: null,
    messages: JSON.stringify([{ role: 'user', content: 'hi' }]),
    response_text: 'ok',
    duration_ms: 10,
    input_tokens: 100,
    output_tokens: 5,
    ok: 1,
    error: null,
    started_at: 1000,
    ...o,
  } as CallRow;
}

// 真实的 harness 每轮都上报 endLine（循环体的结束行）—— 测试里必须带上，
// 否则测的是"旧数据兼容路径"，而不是实际会走的那条。
const LOOP_END = 30;

function iter(loopId: string, n: number, s: number, endLine = LOOP_END): LoopEvent {
  return { type: 'loop.iteration', seq: s, loopId, iteration: n, endLine };
}

test('步骤身份取调用者那一帧，不是最内层的通用封装', () => {
  seq = 0;
  const f = buildFlow([call({ fn: 'review', line: 12 }), call({ fn: 'revise', line: 20 })], []);
  assert.equal(f.steps.length, 2);
  assert.deepEqual(f.steps.map((s) => s.label), ['review', 'revise']);
  assert.ok(f.steps[0].id.endsWith('#review:12'));
});

test('同一行代码发出的调用聚成一个步骤', () => {
  seq = 0;
  const f = buildFlow([1, 2, 3].map(() => call({ fn: 'review', line: 12 })), []);
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].calls, 3);
  assert.equal(f.steps[0].callIds.length, 3);
});

test('轮次靠 seq 交错还原到每次调用上', () => {
  seq = 0;
  const calls = [
    call({ fn: 'review', line: 12, seq: 2 }),
    call({ fn: 'review', line: 12, seq: 4 }),
    call({ fn: 'review', line: 12, seq: 6 }),
  ];
  const evs = [iter(LOOP, 1, 1), iter(LOOP, 2, 3), iter(LOOP, 3, 5)];
  const f = buildFlow(calls, evs);
  assert.deepEqual(f.steps[0].iterations, [1, 2, 3]);
  assert.deepEqual(f.steps[0].spans.map((s) => s.iteration), [1, 2, 3]);
  assert.equal(f.loops[0].iterations, 3);
});

test('循环体内的步骤挂到循环上', () => {
  seq = 0;
  const f = buildFlow([call({ fn: 'review', line: 12, seq: 2 })], [iter(LOOP, 1, 1)]);
  assert.equal(f.steps[0].loopId, LOOP);
  assert.deepEqual(f.loops[0].stepIds, [f.steps[0].id]);
});

test('循环外的调用不该被算进循环', () => {
  seq = 0;
  // 行号在循环起始行之前 —— 不可能在循环体里
  const f = buildFlow([call({ fn: 'setup', line: 5, seq: 2 })], [iter(LOOP, 1, 1)]);
  assert.equal(f.steps[0].loopId, null);
});

test('★ 循环体之后的调用也不该被算进循环（news 上踩到的真实误判）', () => {
  seq = 0;
  // 循环在 10~30 行；这次调用在第 90 行 —— 同一个文件，但在循环体外面。
  // 旧判据只比「行号 ≥ 起始行」，于是 news 里 server.mjs:53 那个读请求体的
  // for await 把整条流水线的调用全吞了，画布上凭空多出一个「正在跑的循环」。
  const f = buildFlow([call({ fn: 'handleRequest', line: 90, seq: 2 })], [iter(LOOP, 1, 1)]);
  assert.equal(f.steps[0].loopId, null);
  assert.equal(f.steps[0].iterations.length, 0);
});

test('嵌套循环取最内层', () => {
  seq = 0;
  const outer = `${F}:10`;
  const inner = `${F}:14`;
  const f = buildFlow(
    [call({ fn: 'work', line: 16, seq: 3 })],
    [iter(outer, 1, 1, 30), iter(inner, 1, 2, 20)],
  );
  assert.equal(f.steps[0].loopId, inner, '内层循环更贴近这次调用');
});

test('分支：某几轮没跑的步骤被标出来', () => {
  seq = 0;
  const calls = [
    call({ fn: 'review', line: 12, seq: 2 }),
    call({ fn: 'fixup', line: 15, seq: 3 }), // 只在第 1 轮跑
    call({ fn: 'review', line: 12, seq: 5 }),
    call({ fn: 'review', line: 12, seq: 7 }),
  ];
  const evs: LoopEvent[] = [
    iter(LOOP, 1, 1), iter(LOOP, 2, 4), iter(LOOP, 3, 6),
    { type: 'loop.exited', seq: 8, loopId: LOOP, iterations: 3, reason: 'condition' },
  ];
  const f = buildFlow(calls, evs);
  const review = f.steps.find((s) => s.label === 'review')!;
  const fixup = f.steps.find((s) => s.label === 'fixup')!;
  assert.equal(review.conditional, false);
  assert.equal(fixup.conditional, true, 'fixup 只在 1/3 轮跑过，应该标成分支');
});

test('循环还在跑时不把「还没轮到」误判成分支', () => {
  seq = 0;
  // 第 2 轮刚进来，review 这一轮还没发出调用
  const f = buildFlow(
    [call({ fn: 'review', line: 12, seq: 2 })],
    [iter(LOOP, 1, 1), iter(LOOP, 2, 3)],
  );
  assert.equal(f.loops[0].running, true);
  assert.equal(f.steps[0].conditional, false);
});

test('在轮次边界上被跳出时，最后一轮不算缺席', () => {
  seq = 0;
  const evs: LoopEvent[] = [
    iter(LOOP, 1, 1),
    iter(LOOP, 2, 3),
    { type: 'loop.exited', seq: 4, loopId: LOOP, iterations: 2, reason: 'break_boundary' },
  ];
  const f = buildFlow([call({ fn: 'review', line: 12, seq: 2 })], evs);
  assert.equal(f.loops[0].running, false);
  assert.equal(f.steps[0].conditional, false, '第 2 轮刚进来就被跳出，不该算 review 缺席');
});

test('并发：时间区间重叠的调用算同一排，紧挨着的不算', () => {
  seq = 0;
  const parallel = [
    call({ fn: 'fetchOne', line: 30, started_at: 1000, duration_ms: 50 }),
    call({ fn: 'fetchOne', line: 30, started_at: 1002, duration_ms: 48 }),
    call({ fn: 'fetchOne', line: 30, started_at: 1001, duration_ms: 49 }),
  ];
  // compose 紧跟在后面（1051），毫秒精度下别把它算成并发
  const after = call({ fn: 'compose', line: 40, started_at: 1051, duration_ms: 20 });
  const f = buildFlow([...parallel, after], []);

  const fetchStep = f.steps.find((s) => s.label === 'fetchOne')!;
  const composeStep = f.steps.find((s) => s.label === 'compose')!;
  assert.equal(fetchStep.concurrency, 3);
  assert.equal(composeStep.concurrency, 1);
  assert.notEqual(fetchStep.row, composeStep.row, 'compose 在 fetch 之后，不该并排');
});

test('真正同时在跑的两个不同步骤并排', () => {
  seq = 0;
  const f = buildFlow(
    [
      call({ fn: 'search', line: 30, started_at: 1000, duration_ms: 100 }),
      call({ fn: 'summarize', line: 40, started_at: 1010, duration_ms: 90 }),
    ],
    [],
  );
  assert.equal(f.steps[0].row, f.steps[1].row);
});

test('总计与错误计数', () => {
  seq = 0;
  const f = buildFlow(
    [
      call({ fn: 'review', line: 12 }),
      call({ fn: 'grab', line: 22, kind: 'http', ok: 0, error: 'boom', input_tokens: 0, output_tokens: 0 }),
    ],
    [],
  );
  assert.equal(f.totals.llm, 1);
  assert.equal(f.totals.tool, 1);
  assert.equal(f.totals.errors, 1);
  assert.equal(f.steps.find((s) => s.label === 'grab')!.kind, 'tool');
  assert.equal(f.steps.find((s) => s.label === 'grab')!.errors, 1);
});

test('节点上带最近一次的输入输出摘要', () => {
  seq = 0;
  const f = buildFlow(
    [
      call({ fn: 'review', line: 12, messages: JSON.stringify([{ role: 'user', content: '第一轮' }]) }),
      call({ fn: 'review', line: 12, messages: JSON.stringify([{ role: 'user', content: '第二轮' }]), response_text: '好了' }),
    ],
    [],
  );
  assert.equal(f.steps[0].preview!.in, '第二轮');
  assert.equal(f.steps[0].preview!.out, '好了');
});

test('失败时输出摘要显示错误而不是空', () => {
  seq = 0;
  const f = buildFlow([call({ fn: 'review', line: 12, ok: 0, error: '429 rate limit', response_text: null })], []);
  assert.match(f.steps[0].preview!.out, /429 rate limit/);
});

test('步骤之间的先后关系；回到前面的步骤标成回边', () => {
  seq = 0;
  const f = buildFlow(
    [
      call({ fn: 'review', line: 12 }),
      call({ fn: 'revise', line: 20 }),
      call({ fn: 'review', line: 12 }),
    ],
    [],
  );
  const back = f.edges.find((e) => e.back);
  assert.ok(back, 'revise → review 应该是回边');
  assert.ok(back!.to.endsWith('#review:12'));
});

test('没有调用栈时按 (模型 + system 指纹) 分步 —— 代理接入的 agent 也要有节点', () => {
  seq = 0;
  const noFrames = { frames: '[]', fn: 'x', line: 1 };
  const f = buildFlow(
    [
      call({ ...noFrames, model: 'gpt-4o', system: '你是审稿人' }),
      call({ ...noFrames, model: 'gpt-4o', system: '你是审稿人' }),
      call({ ...noFrames, model: 'gpt-4o', system: '你是改写助手' }),
    ],
    [],
  );
  assert.equal(f.steps.length, 2, '两种 system prompt 应该分成两步');
  assert.equal(f.steps[0].calls, 2);
  assert.deepEqual(f.steps.map((s) => s.label), ['你是审稿人', '你是改写助手']);
  assert.deepEqual(f.steps.map((s) => s.source), ['proxy', 'proxy']);
});

test('调用栈坏掉时不炸，退回代理式身份', () => {
  seq = 0;
  const f = buildFlow([call({ fn: 'x', line: 1, frames: 'not json', model: 'm', system: null })], []);
  assert.equal(f.steps.length, 1);
  assert.equal(f.steps[0].source, 'proxy');
  assert.equal(f.steps[0].label, 'm');
  assert.equal(f.totals.llm, 1);
});

test('有调用栈时标成 harness 来源', () => {
  seq = 0;
  const f = buildFlow([call({ fn: 'review', line: 12 })], []);
  assert.equal(f.steps[0].source, 'harness');
});

test('代理接入的工具调用按方法 + 路径分步', () => {
  seq = 0;
  const f = buildFlow(
    [call({ fn: 'x', line: 1, frames: '[]', kind: 'http', method: 'GET', url: 'https://api.example.com/v1/search?q=1' })],
    [],
  );
  assert.equal(f.steps[0].label, 'GET /v1/search');
  assert.equal(f.steps[0].kind, 'tool');
});

test('空输入返回空流程', () => {
  const f = buildFlow([], []);
  assert.deepEqual(f.steps, []);
  assert.deepEqual(f.loops, []);
  assert.equal(f.totals.llm, 0);
});
