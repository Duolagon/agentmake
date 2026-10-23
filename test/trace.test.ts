// 「追查」画面背后的推导：prompt 按来源拆开、可疑代码、跨请求对比的规律。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { anatomize } from '../src/server/anatomy.ts';
import { buildFlow } from '../src/server/flow.ts';
import type { CallRow } from '../src/server/flow.ts';
import { stepCompare } from '../src/server/stepcompare.ts';

const HIST = [
  '您好，订单 42 显示已发货但一直没有物流更新',
  '上周就说过了，再不处理我要投诉到消费者协会',
  '客服您好，请问能帮我查一下物流吗',
  '已经三天了还是没有任何消息，非常失望',
  '我已经联系了律师，准备走法律程序处理这件事',
  '能不能先给我一个明确的到货时间',
].map((content, i) => ({ id: i + 1, content }));

// 一个真实的 agent 源文件：system 是字面量，历史只取最后 2 条
const SRC = `// 注释里提到 slice(-9) 不算
async function analyze(history, ticket) {
  const max_tokens = 3; // 输出上限，和丢数据无关
  const msgs = history.slice(-2).map((h) => ({ role: 'user', content: h.content }));
  return chat({ system: '你是工单分析助手。根据对话历史判断优先级。', messages: [...msgs, { role: 'user', content: ticket }] });
}
`;

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-trace-'));
  const file = path.join(dir, 'agent.mjs');
  writeFileSync(file, SRC);
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;
function row(file: string, kind: 'http' | 'llm', fns: [string, number][], extra: Partial<CallRow> = {}): CallRow {
  seq++;
  return {
    call_id: `c${seq}`, run_id: 'r1', seq, kind, provider: kind === 'llm' ? 'openai' : 'http', model: 'm',
    url: 'http://x', method: 'GET', frames: JSON.stringify(fns.map(([fn, line]) => ({ fn, file, line, col: 1 }))),
    system: null, messages: null, response_text: null, duration_ms: 10, input_tokens: null, output_tokens: null,
    ok: 1, error: null, started_at: 1000 + seq, ...extra,
  };
}

test('拆来源：模板定位到源码行、工具结果标出第几条、请求体之类归为运行时拼的', () => {
  const f = fixture();
  try {
    const load = row(f.file, 'http', [['handle', 10], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) });
    const ask = row(f.file, 'llm', [['handle', 11], ['analyze', 5], ['chat', 30]], {
      system: '你是工单分析助手。根据对话历史判断优先级。',
      messages: JSON.stringify([
        ...HIST.slice(-2).map((h) => ({ role: 'user', content: h.content })),
        { role: 'user', content: '订单 42 延迟三天还没到' },
      ]),
    });
    const a = anatomize(ask, [load, ask]);
    const sys = a.parts.find((p) => p.key === 'system')!;
    assert.equal(sys.segments[0].source, 'template');
    assert.equal(sys.segments[0].file, f.file);
    assert.equal(sys.segments[0].line, 5);

    const m0 = a.parts.find((p) => p.key === 'message:0')!.segments[0];
    assert.equal(m0.source, 'tool');
    assert.equal(m0.from, 'loadHistory');
    assert.deepEqual(m0.items, [5]);
    assert.equal(m0.callId, load.call_id);

    assert.equal(a.parts.find((p) => p.key === 'message:2')!.segments[0].source, 'other');
    assert.ok(a.totals.tool > 0 && a.totals.template > 0 && a.totals.other > 0);
  } finally {
    f.cleanup();
  }
});

test('拆来源：上游给了 6 条只用了 2 条 → 列出缺的 4 条，并指到 slice(-2) 那一行（不理注释和 max_tokens）', () => {
  const f = fixture();
  try {
    const load = row(f.file, 'http', [['handle', 10], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) });
    const ask = row(f.file, 'llm', [['handle', 11], ['analyze', 5], ['chat', 30]], {
      system: 's',
      messages: JSON.stringify(HIST.slice(-2).map((h) => ({ role: 'user', content: h.content }))),
    });
    const a = anatomize(ask, [load, ask]);
    assert.equal(a.dropped.length, 1);
    assert.equal(a.dropped[0].total, 6);
    assert.equal(a.dropped[0].used, 2);
    assert.deepEqual(a.dropped[0].items.map((x) => x.index), [1, 2, 3, 4]);
    assert.match(a.dropped[0].items[1].text, /投诉/);
    assert.equal(a.suspects.length, 1);
    assert.equal(a.suspects[0].line, 4);
    assert.match(a.suspects[0].code, /slice\(-2\)/);
  } finally {
    f.cleanup();
  }
});

test('拆来源：全用上了就不报丢失，也不去翻代码', () => {
  const f = fixture();
  try {
    const load = row(f.file, 'http', [['handle', 10], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) });
    const ask = row(f.file, 'llm', [['handle', 11], ['analyze', 5], ['chat', 30]], {
      system: 's', messages: JSON.stringify(HIST.map((h) => ({ role: 'user', content: h.content }))),
    });
    const a = anatomize(ask, [load, ask]);
    assert.deepEqual(a.dropped, []);
    assert.deepEqual(a.suspects, []);
  } finally {
    f.cleanup();
  }
});

test('拆来源：前一步模型的回答被塞进下一步的 prompt，标成「来自 X 的回答」', () => {
  const f = fixture();
  try {
    const answer = '这张工单属于物流延迟，客户情绪激动，建议优先处理。';
    const first = row(f.file, 'llm', [['handle', 10], ['summarize', 40], ['chat', 30]], { response_text: answer });
    const second = row(f.file, 'llm', [['handle', 11], ['reply', 50], ['chat', 30]], {
      system: 's', messages: JSON.stringify([{ role: 'user', content: `上一步的结论：${answer}` }]),
    });
    const a = anatomize(second, [first, second]);
    const seg = a.parts.find((p) => p.key === 'message:0')!.segments.find((s) => s.source === 'llm');
    assert.ok(seg);
    assert.equal(seg.from, 'summarize');
  } finally {
    f.cleanup();
  }
});

// ── 跨请求对比 ─────────────────────────────────────────────

function ticket(runId: string, used: number, answer: string, next: string): CallRow[] {
  const f = '/app/agent.mjs';
  const mk = (kind: 'http' | 'llm', fns: [string, number][], extra: Partial<CallRow>) => ({ ...row(f, kind, fns, extra), run_id: runId });
  return [
    mk('http', [['handle', 10], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) }),
    mk('llm', [['handle', 11], ['analyze', 5], ['chat', 30]], {
      system: 's', messages: JSON.stringify(HIST.slice(-used).map((h) => ({ role: 'user', content: h.content }))),
      response_text: answer,
    }),
    mk('llm', [['handle', 12], [next, 60], ['chat', 30]], { system: next, messages: '[]', response_text: 'ok' }),
  ];
}

test('对比：每次调用记下了上游、缺了什么、输出、下一步', () => {
  const flow = buildFlow(ticket('r1', 2, 'normal', 'polish'), []);
  const sp = flow.steps.find((s) => s.label === 'analyze')!.spans[0];
  assert.equal(sp.input?.items, 6);
  assert.equal(sp.input?.used, 2);
  assert.equal(sp.input?.dropped, true);
  assert.equal(sp.input?.missing.length, 3);
  assert.equal(sp.out, 'normal');
  assert.equal(sp.next, 'polish');
});

test('对比：丢数据的那几次和没丢的结果不一样 → 说出这条规律', () => {
  const calls = [
    ...ticket('r1', 2, 'normal', 'polish'),
    ...ticket('r2', 2, 'normal', 'polish'),
    ...ticket('r3', 6, 'urgent', 'escalate'),
  ];
  const r = stepCompare(buildFlow(calls, []), 'analyze', new Map([['r1', 'POST /t']]))!;
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows.find((x) => x.runId === 'r1')!.trigger, 'POST /t');
  assert.equal(r.split!.dropped.n, 2);
  assert.equal(r.split!.kept.n, 1);
  assert.match(r.pattern!, /被丢掉的 2 次：输出 「normal」2 次，下一步 「polish」2 次；没丢的 1 次：输出 「urgent」1 次/);
  assert.match(r.pattern!, /两组结果不一样/);
});

test('对比：看不出规律就不硬说；全都一样的输出会被点出来', () => {
  const same = [1, 2, 3, 4, 5].flatMap((i) => ticket(`r${i}`, 6, 'normal', 'polish'));
  const r = stepCompare(buildFlow(same, []), 'analyze', new Map())!;
  assert.equal(r.split, null);
  assert.match(r.pattern!, /5 次里输出全是「normal」/);

  const mixed = [...ticket('a', 6, 'normal', 'polish'), ...ticket('b', 6, 'urgent', 'escalate')];
  assert.equal(stepCompare(buildFlow(mixed, []), 'analyze', new Map())!.pattern, null);
  assert.equal(stepCompare(buildFlow(mixed, []), 'nope', new Map()), null);
});
