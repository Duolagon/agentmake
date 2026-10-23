// 「验证」画面背后的推导：两次运行按步骤对齐、★ 注入点、结论；逐行差异；批量回归的编排。
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { computeAnomalies } from '../src/server/anomalies.ts';
import { buildFlow } from '../src/server/flow.ts';
import type { CallRow } from '../src/server/flow.ts';
import { startRegression, getBatch } from '../src/server/regress.ts';
import { checkCall } from '../src/server/rules.ts';
import { diffLines, verifyRuns } from '../src/server/verify.ts';

const HIST = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, content: `第 ${i + 1} 条历史：客户说了一些很长的话 #${i}` }));

let seq = 0;
function row(runId: string, kind: 'http' | 'llm', fns: [string, number][], extra: Partial<CallRow> = {}): CallRow {
  seq++;
  return {
    call_id: `c${seq}`, run_id: runId, seq, kind, provider: kind === 'llm' ? 'openai' : 'http', model: 'm',
    url: 'http://x', method: 'GET', frames: JSON.stringify(fns.map(([fn, line]) => ({ fn, file: '/app/a.mjs', line, col: 1 }))),
    system: null, messages: null, response_text: null, duration_ms: 10, input_tokens: 100, output_tokens: 5,
    ok: 1, error: null, started_at: 1000 + seq, ...extra,
  };
}

/** 有 bug 的版本：只用 2 条历史 → normal → polish；修好的版本：6 条全用 → urgent → escalate */
function run(id: string, fixed: boolean, line = 30): CallRow[] {
  const used = fixed ? HIST : HIST.slice(-2);
  const out = [
    row(id, 'http', [['handle', 10], ['loadHistory', 20]], { response_body: JSON.stringify(HIST) }),
    row(id, 'llm', [['handle', 11], ['analyze', line], ['chat', 5]], {
      system: 's', messages: JSON.stringify(used.map((h) => ({ role: 'user', content: h.content }))),
      response_text: fixed ? 'urgent' : 'normal', request_hash: fixed ? 'h-fixed' : 'h-bug',
    }),
  ];
  out.push(fixed
    ? row(id, 'llm', [['handle', 12], ['escalate', 50], ['chat', 5]], { system: 'e', messages: '[]', response_text: '转人工', request_hash: 'h-esc' })
    : row(id, 'llm', [['handle', 12], ['polish', 40], ['chat', 5]], { system: 'p', messages: '[]', response_text: '优先级：', request_hash: 'h-pol' }));
  return out;
}

const side = (id: string, calls: CallRow[]) => {
  const flow = buildFlow(calls, []);
  return { id, flow, anomalies: computeAnomalies({ flow, calls }) };
};

test('按步骤对齐：★ 落在第一处变化；走了另一条分支的两步分别标「没再执行」「第一次走到」', () => {
  // 修好的版本改了代码，analyze 的行号从 30 漂到了 33 —— 按名字对齐，照样对得上
  const v = verifyRuns(side('A', run('A', false)), side('B', run('B', true, 33)));
  const by = (l: string) => v.pairs.find((p) => p.label === l)!;
  assert.equal(by('loadHistory').status, 'same');
  assert.equal(by('analyze').status, 'changed');
  assert.equal(by('analyze').star, true);
  assert.equal(by('analyze').requestChanged, true);
  assert.equal(by('analyze').a!.input!.used, 2);
  assert.equal(by('analyze').b!.input!.used, 6);
  assert.equal(by('polish').status, 'only_a');
  assert.equal(by('escalate').status, 'only_b');
  assert.equal(v.pairs.filter((p) => p.star).length, 1, '只有一个注入点');
  assert.deepEqual(v.pairs.map((p) => p.label), ['loadHistory', 'analyze', 'polish', 'escalate'], '只在 A 里的步骤插在它在 A 里的前一步后面');
});

test('结论：两边的异常求差 —— 数据丢失修好了就是「变好了」', () => {
  const v = verifyRuns(side('A', run('A', false)), side('B', run('B', true)));
  assert.equal(v.verdict, 'better');
  assert.deepEqual(v.fixed, ['数据在进 prompt 前被丢掉（loadHistory → analyze）']);
  assert.deepEqual(v.introduced, []);
  const same = verifyRuns(side('A', run('A', true)), side('B', run('B', true)));
  assert.equal(same.verdict, 'same');
  assert.ok(same.pairs.every((p) => p.status === 'same'));
  const worse = verifyRuns(side('A', run('A', true)), side('B', run('B', false)));
  assert.equal(worse.verdict, 'worse');
});

test('花费：走了重放缓存的模型调用单独计数', () => {
  const b = run('B', true).map((c) => (c.kind === 'llm' && c.system === 'e' ? { ...c, replayed: 1 } : c));
  const v = verifyRuns(side('A', run('A', false)), side('B', b));
  assert.equal(v.cost.bReal, 1);
  assert.equal(v.cost.bReplayed, 1);
  assert.equal(v.pairs.find((p) => p.label === 'escalate')!.b!.replayed, 1);
});

test('逐行差异：多出来的几行是 add，其余 same；太大时退化成整段替换', () => {
  const d = diffLines(['sys', 'u5', 'u6', 'ticket'], ['sys', 'u1', 'u2', 'u5', 'u6', 'ticket']);
  assert.deepEqual(d.filter((x) => x.op !== 'same').map((x) => `${x.op}:${x.text}`), ['add:u1', 'add:u2']);
  assert.deepEqual(diffLines(['normal'], ['urgent']).map((x) => x.op), ['del', 'add']);
  const big = diffLines(Array(30).fill('a'), Array(30).fill('b'), 10);
  assert.equal(big.length, 60);
});

test('规则：流式响应正文拿不到时，不再误报「空输出」', () => {
  const base = { kind: 'llm', ok: 1, status: 200, finish_reason: null, response_text: null, response_tool_calls: null, tools: null };
  assert.deepEqual(checkCall({ ...base, streaming: 1 }).map((h) => h.name), []);
  assert.deepEqual(checkCall({ ...base, streaming: 0 }).map((h) => h.name), ['rule.empty_output']);
});

// ── 批量回归的编排 ─────────────────────────────────────────

test('回归：原样重发入站请求、带上基线头，逐个判出 改对了 / 没变坏', async () => {
  const got: { url: string; body: string; base: string | undefined; ctype: string | undefined }[] = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    got.push({ url: String(req.url), body, base: req.headers['x-agentmake-baseline'] as string, ctype: req.headers['content-type'] });
    res.end('ok');
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;

  const req = (id: string, body: string) => ({
    run_id: id, kind: 'request', parent_run_id: 'A', trigger: 'POST /t', started_at: 1, ended_at: 2, cwd: '/app', listen: null,
    request_method: 'POST', request_url: '/t?x=1', request_ctype: 'application/json', request_body: body, request_truncated: 0,
  });
  const calls: Record<string, CallRow[]> = { A_r1: run('A_r1', false), A_r2: run('A_r2', true), B_r1: run('B_r1', true), B_r2: run('B_r2', true) };
  const analyze = (id: string) => side(id, calls[id]);
  try {
    const b = startRegression({
      requestRuns: () => [req('A_r1', '{"id":41}'), req('A_r2', '{"id":50}')],
      getRun: (id) => (id === 'A' ? { ...req('A', ''), kind: 'process' } : undefined) as never,
      findTarget: () => ({ ...req('B', ''), run_id: 'B', kind: 'process', listen: JSON.stringify([{ port }]) }) as never,
      findReplayRun: (base) => ({ ...req(base.replace('A', 'B'), ''), ended_at: 3 }) as never,
      analyze,
      verify: (a, bb) => verifyRuns({ id: a, ...analyze(a) }, { id: bb, ...analyze(bb) }),
      broadcast: () => {},
    }, { baseline: 'A' });
    assert.ok(!('error' in b));
    const id = (b as { id: string }).id;
    for (let i = 0; i < 50 && !getBatch(id)!.done; i++) await new Promise((r) => setTimeout(r, 50));
    const done = getBatch(id)!;
    assert.equal(done.done, true);
    assert.deepEqual(got.map((x) => [x.url, x.body, x.base, x.ctype]), [
      ['/t?x=1', '{"id":41}', 'A_r1', 'application/json'],
      ['/t?x=1', '{"id":50}', 'A_r2', 'application/json'],
    ], '请求原样重发，query 也带着；每个都标明对应的基线请求');
    assert.deepEqual(done.items.map((x) => x.outcome), ['fixed', 'ok']);
    assert.equal(done.summary.fixed, 1);
    assert.equal(done.summary.ok, 1);
    assert.match(done.items[0].changed[0], /★ analyze/);
  } finally {
    srv.close();
  }
});

test('回归：找不到在跑的目标、或基线下没有记下请求时，说清楚原因', () => {
  const deps = {
    requestRuns: () => [],
    getRun: () => ({ run_id: 'A' }) as never,
    findTarget: () => undefined,
    findReplayRun: () => undefined,
    analyze: () => ({ flow: buildFlow([], []), anomalies: [] }),
    verify: () => ({}) as never,
    broadcast: () => {},
  };
  const r1 = startRegression(deps, { baseline: 'A' });
  assert.match((r1 as { error: string }).error, /没有记下入站请求/);
  const r2 = startRegression({ ...deps, requestRuns: () => [{ request_url: '/t', run_id: 'x' }] as never }, { baseline: 'A' });
  assert.match((r2 as { error: string }).error, /找不到改好之后在跑的服务/);
});
