// 数据流 / 异常发现 / 步骤命名 —— 「观看」画面背后的推导。
//   1. 测量：上游给了多少、进了下游 prompt 多少（列表数条数，文本算覆盖率）
//   2. 流程图：连线按运行分开算（交错的请求不串边），线上挂测量结果
//   3. 步骤命名：通用封装取上一层，直接调 fetch 的业务函数就是它自己
//   4. 异常：丢数据、规则失败、调用失败、慢、循环多转、重复请求、空数据
import assert from 'node:assert/strict';
import test from 'node:test';
import { computeAnomalies } from '../src/server/anomalies.ts';
import { isDropped, measure } from '../src/server/dataflow.ts';
import { buildFlow } from '../src/server/flow.ts';
import type { CallRow } from '../src/server/flow.ts';

const HIST = [
  '您好，订单 42 显示已发货但一直没有物流更新',
  '上周就说过了，再不处理我要投诉到消费者协会',
  '客服您好，请问能帮我查一下物流吗',
  '已经三天了还是没有任何消息，非常失望',
  '我已经联系了律师，准备走法律程序处理这件事',
  '能不能先给我一个明确的到货时间',
].map((content, i) => ({ id: i + 1, content }));

const llmWith = (texts: string[], system = '你是工单分析助手') => ({
  kind: 'llm',
  system,
  messages: JSON.stringify(texts.map((content) => ({ role: 'user', content }))),
});

// ── 1. 测量 ────────────────────────────────────────────────

test('测量：列表只用了后几条 → 报「6 条 → 2 条」，判为丢失', () => {
  const m = measure([{ kind: 'http', response_body: JSON.stringify(HIST) }], llmWith(HIST.slice(-2).map((h) => h.content)));
  assert.equal(m.items, 6);
  assert.equal(m.used, 2);
  assert.ok(isDropped(m));
});

test('测量：全用上了 → 不算丢失；对象里的主列表也认', () => {
  const body = JSON.stringify({ total: 6, items: HIST });
  const m = measure([{ kind: 'http', response_body: body }], llmWith(HIST.map((h) => h.content)));
  assert.equal(m.items, 6);
  assert.equal(m.used, 6);
  assert.equal(isDropped(m), false);
});

test('测量：下游加了前缀、换了排版，照样认得出（探针取的是内容本身）', () => {
  const formatted = HIST.map((h, i) => `#${i + 1} 客户说：\n  ${h.content}`).join('\n');
  const m = measure([{ kind: 'http', response_body: JSON.stringify(HIST) }], llmWith([formatted]));
  assert.equal(m.used, 6);
});

test('测量：普通文本按句取样算覆盖率', () => {
  const doc = '今天北京天气晴朗，气温二十度左右。\n明天有小雨，出门记得带伞哦。\n后天转多云，适合户外运动。\n大后天降温明显，注意添加衣物。';
  const m = measure([{ kind: 'http', response_body: doc }], llmWith(['资料：今天北京天气晴朗，气温二十度左右。']));
  assert.equal(m.items, null);
  assert.equal(m.coverage, 0.25);
  assert.ok(isDropped(m));
});

test('测量：并发的一批上游算一起；下游不是模型调用时只报体积', () => {
  const a = { kind: 'http', response_body: JSON.stringify(HIST.slice(0, 3)) };
  const b = { kind: 'http', response_body: JSON.stringify(HIST.slice(3)) };
  const m = measure([a, b], llmWith(HIST.map((h) => h.content)));
  assert.equal(m.items, 6);
  assert.equal(m.used, 6);
  const toHttp = measure([a], { kind: 'http' });
  assert.equal(toHttp.used, null);
  assert.equal(toHttp.coverage, null);
  assert.ok(toHttp.bytes > 0);
});

test('测量：响应体被截断过 → 不报条数，只报体积（数不准就不数）', () => {
  const m = measure([{ kind: 'http', response_body: '[{"a":', body_truncated: 1, response_bytes: 999999 }], llmWith(['x']));
  assert.equal(m.items, null);
  assert.equal(m.truncated, true);
  assert.equal(m.bytes, 999999);
});

test('测量：模型的回答流向下一个模型，回答原样进了 prompt 就是 100%', () => {
  const answer = '经过分析，这张工单属于物流延迟问题。客户情绪比较激动，建议优先处理。';
  const m = measure([{ kind: 'llm', response_text: answer, output_tokens: 30 }], llmWith([`上一步的结论：${answer}`]));
  assert.equal(m.tokens, 30);
  assert.equal(m.coverage, 1);
});

// ── 2. 流程图上的数据流 ────────────────────────────────────

const frame = (fn: string, line: number) => ({ fn, file: '/app/agent.mjs', line, col: 1 });
let seq = 0;
function call(runId: string, kind: 'http' | 'llm', fns: [string, number][], extra: Partial<CallRow> = {}): CallRow {
  seq++;
  return {
    call_id: `c${seq}`, run_id: runId, seq, kind, provider: kind === 'llm' ? 'openai' : 'http',
    model: kind === 'llm' ? 'm' : null, url: 'http://x', method: 'GET',
    frames: JSON.stringify(fns.map(([f, l]) => frame(f, l))),
    system: null, messages: null, response_text: null, duration_ms: 10,
    input_tokens: null, output_tokens: null, ok: 1, error: null, started_at: 1000 + seq * 10,
    ...extra,
  };
}

function ticket(runId: string, used: number): CallRow[] {
  return [
    call(runId, 'http', [['handle', 60], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) }),
    call(runId, 'llm', [['handle', 61], ['analyze', 30], ['chat', 10]], {
      system: '分析', messages: JSON.stringify(HIST.slice(-used).map((h) => ({ role: 'user', content: h.content }))),
      response_text: '普通优先级', output_tokens: 5,
    }),
    call(runId, 'llm', [['handle', 62], ['reply', 40], ['chat', 10]], {
      system: '回复', messages: JSON.stringify([{ role: 'user', content: '普通优先级' }]),
    }),
  ];
}

test('流程图：连线上挂着真实数据量，丢失次数按请求累计', () => {
  const f = buildFlow([...ticket('r1', 2), ...ticket('r2', 6)], []);
  const e = f.edges.find((x) => x.from.includes('loadHistory') && x.to.includes('analyze'))!;
  assert.ok(e.data);
  assert.equal(e.data.samples, 2);
  assert.equal(e.data.dropped, 1, 'r1 只用了 2 条，r2 全用了');
  assert.deepEqual(e.data.droppedRuns, ['r1']);
});

test('流程图：两个请求交错执行，不会连出「A 的抓取 → B 的分析」', () => {
  const a = ticket('ra', 6);
  const b = ticket('rb', 6);
  const interleaved = [a[0], b[0], a[1], b[1], a[2], b[2]];
  const f = buildFlow(interleaved, []);
  const self = f.edges.filter((e) => e.from === e.to);
  assert.equal(self.length, 0);
  const lh = f.edges.find((x) => x.from.includes('loadHistory'))!;
  assert.ok(lh.to.includes('analyze'));
  assert.equal(lh.data!.dropped, 0);
});

test('步骤命名：被多处共用的 chat 取上一层；自己发 fetch 的 loadHistory 就叫 loadHistory', () => {
  const f = buildFlow(ticket('r1', 6), []);
  assert.deepEqual(f.steps.map((s) => s.label), ['loadHistory', 'analyze', 'reply']);
});

test('并发判断按运行对齐：一个请求停在断点上很久，不会和别的请求的步骤画成同一排', () => {
  const slow = ticket('r1', 6);
  slow[1].duration_ms = 120_000; // analyze 停了两分钟，reply 自然也是两分钟后才开始
  slow[2].started_at = slow[1].started_at + 120_000;
  const fast = ticket('r2', 6).map((c) => ({ ...c, started_at: c.started_at + 5 }));
  const f = buildFlow([...slow, ...fast], []);
  const rows = new Set(f.steps.map((s) => s.row));
  assert.equal(rows.size, 3, '三步各占一排');
});

test('正在跑的调用：步骤标 running，下游还没回来时线上先报上游给了多少', () => {
  const cs = ticket('r1', 2);
  cs[1] = { ...cs[1], duration_ms: null, ok: null };
  const f = buildFlow(cs.slice(0, 2), []);
  const s = f.steps.find((x) => x.label === 'analyze')!;
  assert.equal(s.running, 1);
  assert.equal(s.runningSince, cs[1].started_at);
  const e = f.edges[0];
  assert.equal(e.data!.waiting, true);
  assert.equal(e.data!.last.items, 6);
  assert.equal(e.data!.samples, 0, '还不知道用了多少，不算一次样本');
});

// ── 3. 异常 ────────────────────────────────────────────────

test('异常：丢数据、规则失败、调用失败都报出来，结果错了的排最前', () => {
  const cs = [...ticket('r1', 2), ...ticket('r2', 2)];
  cs[5] = { ...cs[5], ok: 0, error: 'HTTP 500' };
  const f = buildFlow(cs, []);
  f.steps.find((s) => s.label === 'reply')!.spans[0].failing = ['rule.truncated'];
  const a = computeAnomalies({ flow: f, calls: cs });
  const kinds = a.map((x) => x.kind);
  assert.ok(kinds.includes('data_dropped'));
  assert.ok(kinds.includes('rule'));
  assert.ok(kinds.includes('error'));
  assert.equal(a[0].severity, 'fail');
  const drop = a.find((x) => x.kind === 'data_dropped')!;
  assert.equal(drop.count, '2/2 次');
  assert.match(drop.detail, /loadHistory 给了 6 条，analyze 的 prompt 里只出现了 2 条/);
  assert.equal(a.find((x) => x.kind === 'rule')!.title, '回答被截断');
});

test('异常：比平时慢 —— 拿所在进程的其他请求当参照；样本不够不下结论', () => {
  const base = Array.from({ length: 6 }, (_, i) => ticket(`b${i}`, 6)).flat();
  const cur = ticket('now', 6);
  cur[1].duration_ms = 5000;
  const f = buildFlow(cur, []);
  const slow = computeAnomalies({ flow: f, calls: cur, baselineCalls: [...base, ...cur] }).find((x) => x.kind === 'slow');
  assert.ok(slow);
  assert.match(slow.detail, /analyze 这次 5\.0s，平时 10ms/);
  const few = computeAnomalies({ flow: f, calls: cur, baselineCalls: cur }).find((x) => x.kind === 'slow');
  assert.equal(few, undefined);
});

test('异常：循环比平时多转、同一请求发了好几遍、工具返回空', () => {
  const loopEv = (runId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: 'loop.iteration', seq: i, loopId: '/app/agent.mjs:5', runId, iteration: i + 1 }));
  const base = ['a', 'b', 'c'].flatMap((r) => loopEv(r, 2));
  const cs = [
    call('r1', 'llm', [['h', 1], ['ask', 2], ['chat', 3]], { request_hash: 'same' }),
    call('r1', 'llm', [['h', 1], ['ask', 2], ['chat', 3]], { request_hash: 'same' }),
    call('r1', 'http', [['h', 1], ['search', 9]], { response_body: '[]', response_bytes: 2 }),
  ];
  const f = buildFlow(cs, []);
  const a = computeAnomalies({ flow: f, calls: cs, loopEvents: loopEv('r1', 7), baselineLoopEvents: [...base, ...loopEv('r1', 7)] });
  assert.ok(a.some((x) => x.kind === 'loop' && /转了 7 轮，平时 2 轮/.test(x.detail)));
  assert.ok(a.some((x) => x.kind === 'duplicate' && x.count === '2 遍'));
  assert.ok(a.some((x) => x.kind === 'empty'));
});

test('异常：一切正常时什么都不报', () => {
  const cs = [...ticket('r1', 6), ...ticket('r2', 6)];
  assert.deepEqual(computeAnomalies({ flow: buildFlow(cs, []), calls: cs }), []);
});
