// 「意图 vs 实际」对账的单元测试。
//
// 这里守的是对账的可信度：一旦错配，输出的差异全是噪音 —— 那还不如没有对账。
// 所以重点测绑定规则（显式优先、同名唯一才自动绑、绑不上要报 unbound 而不是瞎报 missing）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptySpec, reconcile, specFromFlow, specToText } from '../src/server/spec.ts';
import type { Spec } from '../src/server/spec.ts';
import { buildFlow } from '../src/server/flow.ts';
import type { CallRow, LoopEvent } from '../src/server/flow.ts';

const F = '/app/agent.mjs';
const LOOP = `${F}:10`;

let n = 0;
function call(o: Partial<CallRow> & { fn: string; line: number }): CallRow {
  return {
    call_id: `c${++n}`,
    seq: n,
    kind: 'llm',
    provider: 'openai',
    model: 'gpt',
    url: 'https://api/x',
    method: 'POST',
    frames: JSON.stringify([
      { file: F, fn: '<top>', line: 1 },
      { file: F, fn: o.fn, line: o.line },
      { file: F, fn: 'callModel', line: 3 },
    ]),
    system: null,
    messages: JSON.stringify([{ role: 'user', content: 'hi' }]),
    response_text: 'ok',
    duration_ms: 10,
    input_tokens: 10,
    output_tokens: 2,
    ok: 1,
    error: null,
    started_at: 1000 + n * 100,
    ...o,
  } as CallRow;
}

const spec = (steps: Spec['steps']): Spec => ({ name: 't', steps });

test('名字唯一对得上时自动绑定，没有噪音', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 }), call({ fn: 'revise', line: 20 })], []);
  const r = reconcile(
    spec([
      { id: 'a', kind: 'llm', label: 'review' },
      { id: 'b', kind: 'llm', label: 'revise', after: ['a'] },
    ]),
    flow,
  );
  assert.equal(r.findings.length, 0);
  assert.equal(r.coverage.matched, 2);
  assert.equal(r.coverage.unexpected, 0);
});

test('名字归一化：大小写、空格、下划线不影响绑定', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'callReview', line: 12 })], []);
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: 'Call_Review' }]), flow);
  assert.equal(r.matches.a, flow.steps[0].id);
  assert.equal(r.findings.length, 0);
});

test('显式绑定优先于名字 —— 改了名也不该断', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 })], []);
  const r = reconcile(
    spec([{ id: 'a', kind: 'llm', label: '评审（中文名，和函数名对不上）', bind: flow.steps[0].id }]),
    flow,
  );
  assert.equal(r.matches.a, flow.steps[0].id);
  assert.equal(r.findings.length, 0);
});

test('★ 名字对不上但确实有没绑的实际步骤 → 报 unbound 并给候选，不冤枉成 missing', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 })], []);
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: '评审' }]), flow);
  const f = r.findings.find((x) => x.kind === 'unbound');
  assert.ok(f, '应该报 unbound');
  assert.equal(f!.level, 'warn');
  assert.deepEqual(f!.candidates?.map((c) => c.label), ['review']);
  assert.ok(!r.findings.some((x) => x.kind === 'missing'), '不该同时报 missing');
});

test('★ 画了但确实没跑到 → missing（blocker）', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 })], []);
  const r = reconcile(
    spec([
      { id: 'a', kind: 'llm', label: 'review' },
      { id: 'b', kind: 'tool', label: '发布' },
    ]),
    flow,
  );
  const f = r.findings.find((x) => x.kind === 'missing');
  assert.ok(f);
  assert.equal(f!.level, 'blocker');
  assert.match(f!.message, /发布/);
});

test('★ 跑了但没画 → unexpected（藏着的重试 / fallback）', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 }), call({ fn: 'retryFallback', line: 40 })], []);
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: 'review' }]), flow);
  const f = r.findings.find((x) => x.kind === 'unexpected');
  assert.ok(f);
  assert.match(f!.message, /retryFallback/);
  assert.equal(r.coverage.unexpected, 1);
});

test('★ 实际顺序和连线反了 → order', () => {
  n = 0;
  // 实际先 revise 后 review
  const flow = buildFlow([call({ fn: 'revise', line: 20 }), call({ fn: 'review', line: 12 })], []);
  const r = reconcile(
    spec([
      { id: 'a', kind: 'llm', label: 'review' },
      { id: 'b', kind: 'llm', label: 'revise', after: ['a'] },
    ]),
    flow,
  );
  const f = r.findings.find((x) => x.kind === 'order');
  assert.ok(f);
  assert.equal(f!.level, 'blocker');
});

test('★ 循环跑得比预期多 → loop_overrun', () => {
  n = 0;
  const calls = [2, 4, 6, 8, 10].map((s) => call({ fn: 'review', line: 12, seq: s }));
  const evs: LoopEvent[] = [1, 3, 5, 7, 9].map((s, i) => ({
    type: 'loop.iteration', seq: s, loopId: LOOP, iteration: i + 1,
  }));
  evs.push({ type: 'loop.exited', seq: 11, loopId: LOOP, iterations: 5, reason: 'condition' });
  const flow = buildFlow(calls, evs);

  const r = reconcile(
    spec([
      { id: 'L', kind: 'loop', label: '精修', maxIterations: 3, bind: LOOP },
      { id: 'a', kind: 'llm', label: 'review', parentId: 'L' },
    ]),
    flow,
  );
  const f = r.findings.find((x) => x.kind === 'loop_overrun');
  assert.ok(f);
  assert.match(f!.message, /最多 3 轮，实际跑了 5 轮/);
});

test('只有一个实际循环时，spec 里的循环免绑定自动对上', () => {
  n = 0;
  const flow = buildFlow(
    [call({ fn: 'review', line: 12, seq: 2 })],
    [{ type: 'loop.iteration', seq: 1, loopId: LOOP, iteration: 1 }],
  );
  const r = reconcile(spec([{ id: 'L', kind: 'loop', label: '精修' }]), flow);
  assert.equal(r.matches.L, LOOP);
});

test('循环一轮没跑 → loop_short', () => {
  n = 0;
  const flow = buildFlow([], [{ type: 'loop.iteration', seq: 1, loopId: LOOP, iteration: 0 }]);
  const r = reconcile(spec([{ id: 'L', kind: 'loop', label: '精修', bind: LOOP }]), flow);
  assert.ok(r.findings.some((x) => x.kind === 'loop_short'));
});

test('★ 没标 optional 但实际是分支 → branch', () => {
  n = 0;
  const calls = [
    call({ fn: 'review', line: 12, seq: 2 }),
    call({ fn: 'fixup', line: 15, seq: 3 }), // 只在第 1 轮
    call({ fn: 'review', line: 12, seq: 5 }),
    call({ fn: 'review', line: 12, seq: 7 }),
  ];
  const evs: LoopEvent[] = [
    { type: 'loop.iteration', seq: 1, loopId: LOOP, iteration: 1 },
    { type: 'loop.iteration', seq: 4, loopId: LOOP, iteration: 2 },
    { type: 'loop.iteration', seq: 6, loopId: LOOP, iteration: 3 },
    { type: 'loop.exited', seq: 8, loopId: LOOP, iterations: 3, reason: 'condition' },
  ];
  const flow = buildFlow(calls, evs);

  const withoutFlag = reconcile(
    spec([
      { id: 'L', kind: 'loop', label: '精修', bind: LOOP },
      { id: 'a', kind: 'llm', label: 'review', parentId: 'L' },
      { id: 'b', kind: 'llm', label: 'fixup', parentId: 'L' },
    ]),
    flow,
  );
  assert.ok(withoutFlag.findings.some((x) => x.kind === 'branch'), '没标 optional 应该报出来');

  const withFlag = reconcile(
    spec([
      { id: 'L', kind: 'loop', label: '精修', bind: LOOP },
      { id: 'a', kind: 'llm', label: 'review', parentId: 'L' },
      { id: 'b', kind: 'llm', label: 'fixup', parentId: 'L', optional: true },
    ]),
    flow,
  );
  assert.ok(!withFlag.findings.some((x) => x.kind === 'branch'), '标了 optional 就不该再报');
});

test('实际有失败 → failed（blocker）', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12, ok: 0, error: '429' })], []);
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: 'review' }]), flow);
  const f = r.findings.find((x) => x.kind === 'failed');
  assert.ok(f);
  assert.equal(f!.level, 'blocker');
});

test('候选要求同类型 —— 工具步骤不该拿 LLM 步骤当候选，那是真没实现', () => {
  n = 0;
  const flow = buildFlow(
    [call({ fn: 'review', line: 12 }), call({ fn: 'sneaky', line: 40 })],
    [],
  );
  const r = reconcile(
    spec([
      { id: 'a', kind: 'llm', label: 'review' },
      { id: 'b', kind: 'tool', label: '发布' },
    ]),
    flow,
  );
  const f = r.findings.find((x) => x.specStepId === 'b');
  assert.equal(f?.kind, 'missing', '同类型没有空闲步骤时该报 missing 而不是 unbound');
  assert.equal(f?.level, 'blocker');
});

test('blocker 排在 warn 前面 —— 先看要命的', () => {
  n = 0;
  const flow = buildFlow(
    [call({ fn: 'review', line: 12, ok: 0, error: '429' }), call({ fn: 'sneaky', line: 40 })],
    [],
  );
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: 'review' }]), flow);
  assert.ok(r.findings.some((f) => f.level === 'blocker'), '失败应该是 blocker');
  assert.ok(r.findings.some((f) => f.level === 'warn'), '未画到的步骤应该是 warn');
  assert.equal(r.findings[0].level, 'blocker');
});

test('★ 还没写规格时一条差异都不报 —— 否则第一次打开页面每步都被标成「规格外」', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 }), call({ fn: 'revise', line: 20 })], []);
  const r = reconcile(emptySpec(), flow);
  assert.deepEqual(r.findings, [], '「你还没写规格」和「你写了但漏了这步」是两件事');
  assert.equal(r.coverage.unexpected, 0);
  assert.equal(r.coverage.total, 0);
});

test('一旦规格里有内容，漏掉的步骤就要报出来', () => {
  n = 0;
  const flow = buildFlow([call({ fn: 'review', line: 12 }), call({ fn: 'revise', line: 20 })], []);
  const r = reconcile(spec([{ id: 'a', kind: 'llm', label: 'review' }]), flow);
  assert.equal(r.coverage.unexpected, 1);
  assert.equal(r.findings.filter((f) => f.kind === 'unexpected').length, 1);
});

test('★ 从实际运行反推的规格，回头对账必须零差异（否则反推是错的）', () => {
  n = 0;
  const calls = [
    call({ fn: 'review', line: 12, seq: 2 }),
    call({ fn: 'review', line: 12, seq: 4 }),
  ];
  const evs: LoopEvent[] = [
    { type: 'loop.iteration', seq: 1, loopId: LOOP, iteration: 1 },
    { type: 'loop.iteration', seq: 3, loopId: LOOP, iteration: 2 },
    { type: 'loop.exited', seq: 5, loopId: LOOP, iterations: 2, reason: 'condition' },
  ];
  const flow = buildFlow(calls, evs);
  const drafted = specFromFlow(flow, 'auto');
  const r = reconcile(drafted, flow);
  assert.deepEqual(r.findings, [], `反推的规格不该有差异，实得：${JSON.stringify(r.findings)}`);
  assert.equal(r.coverage.unexpected, 0);
});

test('规格转文本给 AI 看：id、绑定状态、意图都在', () => {
  const t = specToText(
    spec([
      { id: 'L', kind: 'loop', label: '精修', maxIterations: 3 },
      { id: 'a', kind: 'llm', label: '评审', parentId: 'L', intent: '挑毛病', bind: 'x#review:1' },
    ]),
  );
  assert.match(t, /\[L\] 精修/);
  assert.match(t, /最多 3 轮/);
  assert.match(t, /意图：挑毛病/);
  assert.match(t, /已绑定/);
  assert.match(t, /未绑定/);
});
