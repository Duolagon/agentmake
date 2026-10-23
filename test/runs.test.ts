// 运行组 / 请求级运行 / 重放关联 —— 存储层的单测。
//   1. 请求级运行的 run.started 晚于它的第一个调用到达，字段也要补全
//   2. 范围：选进程 = 它自己 + 它的请求；选组 = 组里所有运行
//   3. 重放：基线是进程时在它所有请求里找；对比时按「同触发请求、第几次」自动对上基线
//   4. 老库迁移
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/server/store.ts';

function tmp() {
  const dir = mkdtempSync(path.join(tmpdir(), 'am-runs-'));
  const file = path.join(dir, 'test.db');
  return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;
let ts = 1_000_000;
const started = (s: Store, runId: string, extra: Record<string, unknown> = {}) =>
  s.ingest({ type: 'run.started', runId, seq: seq++, ts: ts++, cwd: '/srv', argv: [], pid: 1, ...extra } as never);

function llm(s: Store, runId: string, callId: string, q: string, opts: { replayed?: boolean } = {}) {
  const request = { provider: 'openai', model: 'm', system: 's', messages: [{ role: 'user', content: q }], tools: [], params: {}, raw: {} };
  s.ingest({ type: 'llm.before', runId, seq: seq++, ts: ts++, callId, url: 'http://x/v1/chat/completions', frames: [], request } as never);
  s.ingest({
    type: 'llm.after', runId, seq: seq++, ts: ts++, callId, ok: true, status: 200, durationMs: 1, error: null,
    streaming: false, replayed: opts.replayed, requestHash: `h_${q}`,
    response: { text: `答 ${q}`, toolCalls: [], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 }, raw: { q } },
  } as never);
}

/** 一个常驻服务进程：两个 POST /ask 请求 + 一个 GET /feed 请求 */
function server(s: Store, pid: string, qs: string[], extra: Record<string, unknown> = {}) {
  started(s, pid, { kind: 'process', ...extra });
  qs.forEach((q, i) => {
    const rid = `${pid}_r${i + 1}`;
    started(s, rid, { kind: 'request', parentRunId: pid, trigger: 'POST /ask', ...extra });
    llm(s, rid, `${rid}_c`, q);
    s.ingest({ type: 'run.ended', runId: rid, seq: seq++, ts: ts++, exitCode: null, httpStatus: 200 } as never);
  });
}

test('时序：请求级运行的第一个调用先到、run.started 后到，父运行与触发请求仍然补上', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    started(s, 'p1', { kind: 'process' });
    llm(s, 'p1_r1', 'c1', 'q');                       // 先到：ensureRun 插了一条占位
    started(s, 'p1_r1', { kind: 'request', parentRunId: 'p1', trigger: 'POST /ask' });
    const r = s.getRun('p1_r1')!;
    assert.equal(r.kind, 'request');
    assert.equal(r.parent_run_id, 'p1');
    assert.equal(r.trigger, 'POST /ask');
    assert.equal(r.group_id, 'p1', '组继承自父运行');
  } finally {
    t.cleanup();
  }
});

test('范围：选进程看到它所有请求的调用；选请求只看自己', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a', 'b']);
    assert.equal((s.listCalls('p1') as unknown[]).length, 2);
    assert.equal((s.listCalls('p1_r1') as unknown[]).length, 1);
    assert.equal(s.llmCallsFor('p1').length, 2);
    assert.equal((s.flowCalls('p1') as unknown[]).length, 2);

    const runs = s.listRuns() as any[];
    const p = runs.find((r) => r.run_id === 'p1');
    assert.equal(p.call_count, 2, '进程的调用数包含它的请求');
    assert.equal(p.child_runs, 2);
    const r1 = runs.find((r) => r.run_id === 'p1_r1');
    assert.equal(r1.http_status, 200);
  } finally {
    t.cleanup();
  }
});

test('范围：评分与失败查询也按进程汇总', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a', 'b']);
    s.upsertScore({ callId: 'p1_r2_c', name: 'correct', passed: false, source: 'ai' });
    assert.equal(s.scoreSummary('p1').failedCalls, 1);
    assert.equal((s.failures('p1') as unknown[]).length, 1);
    assert.equal((s.failures('p1_r1') as unknown[]).length, 0);
    assert.equal((s.listRuns() as any[]).find((r) => r.run_id === 'p1').failing, 1);
  } finally {
    t.cleanup();
  }
});

test('运行组：AGENTMAKE_GROUP 把多个进程归到一起', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a'], { groupId: 'batch1' });
    server(s, 'p2', ['b'], { groupId: 'batch1' });
    server(s, 'p3', ['c']);
    assert.equal((s.listCalls('batch1') as unknown[]).length, 2);
    assert.equal((s.listRuns(50, 'batch1') as unknown[]).length, 4, '两个进程 + 两个请求');
    const g = (s.listGroups() as any[]).find((x) => x.group_id === 'batch1');
    assert.equal(g.runs, 4);
    assert.equal(g.request_runs, 2);
    assert.equal(g.call_count, 2);
    assert.equal(s.getRun('p3_r1')!.group_id, 'p3', '没指定组时，组就是进程自己');
  } finally {
    t.cleanup();
  }
});

test('重放：基线是进程时，在它处理过的任何一个请求里找同一个调用', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a', 'b']);
    assert.ok(s.findReplay('p1', 'h_b'), '第二个请求里的调用也找得到');
    assert.ok(s.findReplay('p1_r2', 'h_b'));
    assert.equal(s.findReplay('p1_r1', 'h_b'), undefined, '基线是单个请求时只在它里面找');
  } finally {
    t.cleanup();
  }
});

test('重放关联：按「同触发请求、第几次」对上基线里的那个请求', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a', 'b']);
    // 重启后的进程以 p1 为基线
    server(s, 'p2', ['a', 'x'], { replayOf: 'p1' });
    assert.equal(s.getRun('p2_r1')!.replay_of, 'p1');
    assert.equal(s.resolveBaseline('p2_r1'), 'p1_r1');
    assert.equal(s.resolveBaseline('p2_r2'), 'p1_r2');
    assert.equal(s.resolveBaseline('p2'), 'p1', '进程对进程');
    assert.equal(s.resolveBaseline('p1_r1'), null, '不是重放出来的就没有缺省基线');
  } finally {
    t.cleanup();
  }
});

test('重放关联：服务端在查缓存时记下基线（Python / 代理路径不带 replayOf 也能关联上）', () => {
  const t = tmp();
  try {
    const s = new Store(t.file);
    server(s, 'p1', ['a']);
    s.noteReplayOf('py_run', 'p1');
    s.noteReplayOf('py_run', 'other');   // 第一次记下的为准
    assert.equal(s.getRun('py_run')!.replay_of, 'p1');
    started(s, 'py_run', { kind: 'process' }); // run.started 后到，不能把 replay_of 冲掉
    assert.equal(s.getRun('py_run')!.replay_of, 'p1');
  } finally {
    t.cleanup();
  }
});

test('迁移：老库的 runs 表没有新列，打开后补上并给老运行填上组', () => {
  const t = tmp();
  try {
    const db = new DatabaseSync(t.file);
    db.exec(`CREATE TABLE runs (run_id TEXT PRIMARY KEY, cwd TEXT, argv TEXT, pid INTEGER,
                                started_at INTEGER, ended_at INTEGER, exit_code INTEGER);
             INSERT INTO runs (run_id, started_at) VALUES ('old_run', 1);`);
    db.close();
    const s = new Store(t.file);
    const r = s.getRun('old_run')!;
    assert.equal(r.group_id, 'old_run');
    assert.equal(r.kind, 'process');
    server(s, 'p1', ['a']);
    assert.equal((s.listCalls('p1') as unknown[]).length, 1);
  } finally {
    t.cleanup();
  }
});
