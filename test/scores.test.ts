// 评分与规则判定的单测。
//   1. 规则：截断 / 空输出 / 工具参数坏了 / 调了没声明的工具 / 被拦截 —— 以及哪些情况**不该**判
//   2. 存储：落库即判、同名覆盖、failures 把「200 但判失败」的调用也找出来、老库补判
//   3. 对比：改完之后失败判定的增减 → 变好 / 变差
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRuns } from '../src/server/compare.ts';
import { checkCall, type RuleInput } from '../src/server/rules.ts';
import { Store } from '../src/server/store.ts';

const base: RuleInput = {
  kind: 'llm', ok: 1, status: 200, faked: 0, finish_reason: 'stop',
  response_text: '好的', response_tool_calls: null, tools: null,
};
const names = (c: Partial<RuleInput>) => checkCall({ ...base, ...c }).map((h) => h.name);

// ── 1. 规则 ────────────────────────────────────────────────

test('规则: 正常回答不判任何失败', () => {
  assert.deepEqual(names({}), []);
});

test('规则: 三家的截断写法都认', () => {
  for (const f of ['length', 'max_tokens', 'MAX_TOKENS']) {
    assert.deepEqual(names({ finish_reason: f }), ['rule.truncated'], f);
  }
});

test('规则: 被安全策略拦截', () => {
  assert.deepEqual(names({ finish_reason: 'content_filter' }), ['rule.blocked']);
  assert.deepEqual(names({ finish_reason: 'SAFETY' }), ['rule.blocked']);
});

test('规则: 空输出 —— 但只调工具不算空', () => {
  assert.deepEqual(names({ response_text: '  \n' }), ['rule.empty_output']);
  const calls = JSON.stringify([{ id: 'c', name: 'search', args: {} }]);
  assert.deepEqual(names({ response_text: '', response_tool_calls: calls }), []);
});

test('规则: 截断且什么都没输出 → 两条都报（推理模型把预算烧光的典型症状）', () => {
  assert.deepEqual(names({ finish_reason: 'length', response_text: '' }), ['rule.truncated', 'rule.empty_output']);
});

test('规则: 工具参数不是合法 JSON', () => {
  const calls = JSON.stringify([{ id: 'c', name: 'search', args: '{"q":', argsInvalid: true }]);
  const hits = checkCall({ ...base, response_tool_calls: calls });
  assert.deepEqual(hits.map((h) => h.name), ['rule.tool_args_invalid']);
  assert.match(hits[0].comment, /search/);
});

test('规则: 调了请求里没声明的工具；没声明任何工具时不判', () => {
  const calls = JSON.stringify([{ id: 'c', name: 'refund', args: {} }]);
  const tools = JSON.stringify([{ name: 'search' }]);
  assert.deepEqual(names({ response_tool_calls: calls, tools }), ['rule.unknown_tool']);
  assert.deepEqual(names({ response_tool_calls: calls, tools: '[]' }), []);
});

test('规则: HTTP 失败 / 伪造的回答 / 普通 HTTP 调用 / 还没完成 —— 都不判', () => {
  assert.deepEqual(names({ ok: 0, response_text: '' }), [], 'HTTP 失败已经是失败，不叠判');
  assert.deepEqual(names({ faked: 1, response_text: '' }), [], '伪造的是用户自己写的');
  assert.deepEqual(names({ kind: 'http', response_text: '' }), []);
  assert.deepEqual(names({ status: null, response_text: '' }), [], '还没收到响应');
});

// ── 2. 存储 ────────────────────────────────────────────────

function tmpStore() {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-scores-'));
  const file = path.join(dir, 'test.db');
  return { file, open: () => new Store(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;
function llmCall(store: Store, runId: string, callId: string, resp: { text: string; finish: string }) {
  const ts = Date.now();
  store.ingest({
    type: 'llm.before', runId, seq: seq++, ts, callId, url: 'http://x/v1/chat/completions', frames: [],
    request: { provider: 'openai', model: 'm', system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], params: {}, raw: {} },
  });
  store.ingest({
    type: 'llm.after', runId, seq: seq++, ts: ts + 1, callId, ok: true, status: 200, durationMs: 1, error: null, streaming: false,
    response: { text: resp.text, toolCalls: [], finishReason: resp.finish, usage: { inputTokens: 1, outputTokens: 1 }, raw: {} },
  });
}

test('存储: 落库时就跑规则，failures 找得到「200 但被截断」的调用', () => {
  const t = tmpStore();
  try {
    const s = t.open();
    llmCall(s, 'r1', 'c_ok', { text: '好', finish: 'stop' });
    llmCall(s, 'r1', 'c_cut', { text: '半截', finish: 'length' });
    const f = s.failures('r1') as any[];
    assert.deepEqual(f.map((x) => x.call_id), ['c_cut']);
    assert.equal(f[0].ok, 1, 'HTTP 层是成功的');
    assert.deepEqual(f[0].failing.map((x: any) => x.name), ['rule.truncated']);
    assert.deepEqual([...s.failingByCall('r1').keys()], ['c_cut']);
    assert.equal((s.listRuns() as any[])[0].failing, 1);
  } finally {
    t.cleanup();
  }
});

test('存储: AI 判定同名覆盖；判为通过后不再算失败', () => {
  const t = tmpStore();
  try {
    const s = t.open();
    llmCall(s, 'r1', 'c1', { text: '优先级 normal', finish: 'stop' });
    const first = s.upsertScore({ callId: 'c1', name: 'correct', passed: false, comment: '应该是 urgent', source: 'ai' });
    assert.ok(!('error' in first));
    assert.equal((s.failures('r1') as any[]).length, 1);

    s.upsertScore({ callId: 'c1', name: 'correct', passed: true, comment: '改完对了', source: 'ai' });
    const all = s.scores({ callId: 'c1' });
    assert.equal(all.length, 1, '同目标同名同来源只留一条');
    assert.equal(all[0].passed, 1);
    assert.equal((s.failures('r1') as any[]).length, 0);
  } finally {
    t.cleanup();
  }
});

test('存储: 运行级评分以 kind=run 出现在 failures 里；目标不存在要报错', () => {
  const t = tmpStore();
  try {
    const s = t.open();
    llmCall(s, 'r1', 'c1', { text: '好', finish: 'stop' });
    s.upsertScore({ runId: 'r1', name: 'final_answer', passed: false, comment: '最终结论错了', source: 'ai' });
    const f = s.failures('r1') as any[];
    assert.equal(f[0].kind, 'run');
    assert.equal(f[0].failing[0].name, 'final_answer');
    assert.deepEqual(s.scoreSummary('r1').runFailures, ['final_answer']);

    assert.ok('error' in s.upsertScore({ callId: 'nope', name: 'x', passed: false, source: 'ai' }));
    assert.ok('error' in s.upsertScore({ runId: 'nope', name: 'x', passed: false, source: 'ai' }));
    assert.ok('error' in s.upsertScore({ name: 'x', passed: false, source: 'ai' }));
  } finally {
    t.cleanup();
  }
});

test('存储: 规则上线前的老数据，重新打开库时补判', () => {
  const t = tmpStore();
  try {
    const s = t.open();
    llmCall(s, 'r1', 'c_cut', { text: '', finish: 'length' });
    // 模拟老库：判定结果不存在、标记为没检查过
    s.db.exec("DELETE FROM scores; UPDATE calls SET rules_checked=0;");
    assert.equal(s.scores({ callId: 'c_cut' }).length, 0);
    s.db.close();

    const reopened = t.open();
    assert.deepEqual(
      reopened.scores({ callId: 'c_cut' }).map((x) => x.name).sort(),
      ['rule.empty_output', 'rule.truncated'],
    );
    reopened.db.close();
  } finally {
    t.cleanup();
  }
});

test('存储: 规则判定不会覆盖 AI 的同名判定（来源不同是两条）', () => {
  const t = tmpStore();
  try {
    const s = t.open();
    llmCall(s, 'r1', 'c1', { text: '半截', finish: 'length' });
    s.upsertScore({ callId: 'c1', name: 'rule.truncated', passed: true, comment: '这里截断是预期的', source: 'human' });
    assert.equal(s.scores({ callId: 'c1' }).length, 2);
  } finally {
    t.cleanup();
  }
});

// ── 3. 对比 ────────────────────────────────────────────────

const row = (id: string) => ({
  call_id: id, seq: 0, model: 'm', request_hash: 'h', frames: '[]', system: 's', messages: '[]',
  response_text: 'x', response_tool_calls: null, input_tokens: 1, output_tokens: 1, duration_ms: 1, replayed: 0, ok: 1,
});
const summary = (n: number, runFailures: string[] = []) => ({ failedCalls: n, runFailures, byName: {} });

test('对比: A 里失败、B 里修好了 → better，并指出修好的是哪一处', () => {
  const r = compareRuns('A', 'B', [row('a0'), row('a1')], [row('b0'), row('b1')], {
    failingA: new Map([['a1', ['correct']]]),
    failingB: new Map(),
    summaryA: summary(1),
    summaryB: summary(0),
  });
  assert.equal(r.scores?.verdict, 'better');
  assert.deepEqual(r.scores?.fixed, ['#1 correct']);
  assert.deepEqual(r.pairs[1].failing, { a: ['correct'], b: [] });
  assert.equal(r.pairs[0].failing, undefined, '两边都没失败的那对不带 failing');
});

test('对比: 修好一处又冒出一处 → mixed；运行级的也算', () => {
  const r = compareRuns('A', 'B', [row('a0')], [row('b0')], {
    failingA: new Map([['a0', ['rule.truncated']]]),
    failingB: new Map(),
    summaryA: summary(1),
    summaryB: summary(0, ['final_answer']),
  });
  assert.equal(r.scores?.verdict, 'mixed');
  assert.deepEqual(r.scores?.introduced, ['运行 final_answer']);
});

test('对比: 不传评分上下文时没有 scores 字段（老调用方式照旧）', () => {
  const r = compareRuns('A', 'B', [row('a0')], [row('b0')]);
  assert.equal(r.scores, undefined);
});
