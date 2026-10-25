// 持久化：node:sqlite（Node 内置，零依赖）。
//
// 两张表分工：
//   events —— 原始事件流，追加写，SSE 断线续传的依据
//   calls  —— 由 llm.before + llm.after 合并出的调用视图，给 UI 和后续 MCP 直接查
//
// 分开存是刻意的：events 是不可变日志，calls 是可查询的物化视图。UI 要按运行/节点/
// 成本排序过滤，直接在 events 上做会很难看。

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { HistoryRun, RunStats } from './history.ts';
import type { TranscriptCall } from './transcript.ts';
import type { AgentEvent, HttpBody, HttpCall, LLMAfter, LLMBefore, LLMPatched, RunStarted } from '../shared/types.ts';
import { checkCall, type RuleInput } from './rules.ts';

/**
 * 一条评分。形状对齐 Langfuse 的 score（name / value / 来源 / comment，挂在 trace 或 observation 上），
 * 将来导出过去不用再转一道。多了一个 passed：「这次算不算失败」必须是明确的，
 * find_failures 和运行对比都靠它，不能让每个消费者自己去猜数值阈值。
 */
export type ScoreInput = {
  runId?: string | null;
  /** 省略 = 给整次运行打分 */
  callId?: string | null;
  name: string;
  /** true 通过 / false 失败 / null 只记录、不表态 */
  passed: boolean | null;
  value?: number | null;
  label?: string | null;
  comment?: string | null;
  /** rule = 规则自动判定 · ai = AI 编程助手经 MCP 判定 · human = 人在页面上判定 */
  source: 'rule' | 'ai' | 'human';
};

export type ScoreRow = {
  score_id: string;
  run_id: string;
  call_id: string | null;
  name: string;
  passed: number | null;
  value: number | null;
  label: string | null;
  comment: string | null;
  source: string;
  created_at: number;
};

export type CallRow = {
  call_id: string;
  run_id: string;
  seq: number;
  url: string;
  provider: string;
  model: string;
  system: string | null;
  messages: string;
  tools: string;
  params: string;
  raw_request: string;
  status: number | null;
  ok: number | null;
  duration_ms: number | null;
  response_text: string | null;
  /** JSON: ToolCallIR[]，模型这次决定调的工具。没调工具时为 null */
  response_tool_calls: string | null;
  finish_reason: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  raw_response: string | null;
  error: string | null;
  streaming: number;
  started_at: number;
};

/**
 * 一个运行 id 代表的范围：它自己 + 挂在它下面的请求级运行 + 以它为组的运行。
 *
 * 常驻服务里进程运行自己几乎没有调用，调用都在请求级运行里；选中进程看的应该是它处理过的
 * 所有请求。组 id 不必是某次运行 —— AGENTMAKE_GROUP 给的名字也能当范围用。
 * 绑定参数要给三遍同一个 id（见 scope()）。
 */
const SCOPE = '(SELECT run_id FROM runs WHERE run_id=? OR parent_run_id=? OR group_id=?)';

/**
 * 读出来给页面 / 流程 / 异常用的 error 列。早先流式调用读完就被调用方 abort 掉（dsh 那样），
 * 探针把「This operation was aborted」记成了错误 —— 但 HTTP 成功、结束信号也收到了，那不是失败。
 * 库里的原始记录不动，读的时候按真实情况算。
 */
const ERROR_COL = `CASE WHEN ok = 1 AND finish_reason IS NOT NULL THEN NULL ELSE error END AS error`;
const scope = (id: string) => [id, id, id];

/**
 * 请求级运行的到达顺序。并发请求常在同一毫秒到达，只按 started_at 排会出现平局、
 * 顺序随查询计划漂移。runId 末尾的 _rN 是到达序号：先比长度再比字面，_r10 才排在 _r9 后面。
 */
const ARRIVAL = 'started_at, length(run_id), run_id';

export type RunRow = {
  run_id: string;
  kind: string | null;
  parent_run_id: string | null;
  group_id: string | null;
  trigger: string | null;
  replay_of: string | null;
  started_at: number;
};

/**
 * 写进事件日志、推给页面的版本：去掉响应体。
 *
 * 响应体最多 256KB，原样进 events 表等于存两份，原样走 SSE 等于每个打开的页面都收一遍 ——
 * 页面要看的时候按调用去取就行。calls 表里的那份才是给数据流图用的。
 */
export function slimEvent(ev: AgentEvent): AgentEvent {
  if (ev.type === 'http.body') return { ...ev, body: '' };
  if (ev.type === 'http.call' && ev.responseBody != null) return { ...ev, responseBody: undefined };
  if (ev.type === 'run.ended' && ev.request) return { ...ev, request: { ...ev.request, body: '' } };
  return ev;
}

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    // WAL：SSE 长读与事件高频写并行，不互相阻塞
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=NORMAL;
      PRAGMA busy_timeout=5000;

      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        cwd        TEXT,
        argv       TEXT,
        pid        INTEGER,
        started_at INTEGER,
        ended_at   INTEGER,
        exit_code  INTEGER,
        kind          TEXT DEFAULT 'process',   -- process | request
        parent_run_id TEXT,                     -- 请求级运行 → 它所在的进程运行
        group_id      TEXT,                     -- 运行组；缺省为顶层运行自己
        trigger       TEXT,                     -- 触发它的入站请求，如 POST /api/dispatch
        http_status   INTEGER,                  -- 请求级运行回给客户端的状态码
        replay_of     TEXT,                     -- 以谁为重放基线（运行或运行组）
        listen        TEXT,                     -- 进程在监听的端口（JSON 数组），批量回归往这里重发
        request_method TEXT,                    -- 请求级运行的入站请求，批量回归时原样重发
        request_url    TEXT,
        request_ctype  TEXT,
        request_body   TEXT,
        request_truncated INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id     INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL,
        seq    INTEGER NOT NULL,
        ts     INTEGER NOT NULL,
        type   TEXT NOT NULL,
        json   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);

      -- agent 规格（意图图）。和运行数据放同一个库：对账要把两边拉到一起，
      -- 分成两处存只会多一个「规格文件找不到」的失败模式。
      CREATE TABLE IF NOT EXISTS specs (
        name       TEXT PRIMARY KEY,
        json       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- 导入的工程目录。存路径和启动命令，好让用户下次打开还在。
      CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        dir        TEXT NOT NULL,
        kind       TEXT NOT NULL,
        cmd        TEXT NOT NULL,
        trigger    TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS calls (
        call_id           TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL,
        seq               INTEGER NOT NULL,
        kind              TEXT NOT NULL DEFAULT 'llm',   -- llm | http
        method            TEXT,
        frames            TEXT,                          -- JSON: 调用路径，执行图的原料
        url               TEXT,
        provider          TEXT,
        model             TEXT,
        system            TEXT,
        messages          TEXT,
        tools             TEXT,
        params            TEXT,
        raw_request       TEXT,
        status            INTEGER,
        ok                INTEGER,
        duration_ms       INTEGER,
        response_text     TEXT,
        response_tool_calls TEXT,                        -- JSON: 模型发起的工具调用
        finish_reason     TEXT,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cache_read_tokens INTEGER,
        raw_response      TEXT,
        error             TEXT,
        streaming         INTEGER DEFAULT 0,
        faked             INTEGER DEFAULT 0,
        aborted           INTEGER DEFAULT 0,
        replayed          INTEGER DEFAULT 0,
        patched           INTEGER DEFAULT 0,
        request_hash      TEXT,
        started_at        INTEGER,
        rules_checked     INTEGER DEFAULT 0,             -- 规则判定跑过没有（见 rules.ts）
        response_body     TEXT,                          -- 工具调用的响应体（有上限），数据流图用
        response_bytes    INTEGER,
        body_truncated    INTEGER DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_calls_run ON calls(run_id, seq);

      -- 评分：调用级（call_id 非空）或运行级（call_id 为空）。
      -- 同一目标、同一名字、同一来源只留一条 —— AI 改完重判是覆盖，不是越攒越多。
      CREATE TABLE IF NOT EXISTS scores (
        score_id   TEXT PRIMARY KEY,
        run_id     TEXT NOT NULL,
        call_id    TEXT,
        name       TEXT NOT NULL,
        passed     INTEGER,             -- 1 通过 / 0 失败 / NULL 不表态
        value      REAL,
        label      TEXT,
        comment    TEXT,
        source     TEXT NOT NULL,       -- rule | ai | human
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_scores_run ON scores(run_id);
      CREATE INDEX IF NOT EXISTS idx_scores_call ON scores(call_id);
      CREATE INDEX IF NOT EXISTS idx_calls_hash ON calls(request_hash);
    `);
    this.migrate();
    this.backfillRules();
  }

  /**
   * 补列。
   *
   * CREATE TABLE IF NOT EXISTS 对已存在的表什么都不做 —— 加了新列之后，
   * 老库会在第一次写入时报「no such column」。本地工具不值得上迁移框架，
   * 但也不能让用户为了一个新列去删库。
   */
  private migrate(): void {
    const have = new Set(
      (this.db.prepare('PRAGMA table_info(calls)').all() as { name: string }[]).map((c) => c.name),
    );
    const tableCols: [string, [string, string][]][] = [
      ['projects', [['trigger', 'TEXT']]],
      ['runs', [
        ['kind', "TEXT DEFAULT 'process'"],
        ['parent_run_id', 'TEXT'],
        ['group_id', 'TEXT'],
        ['trigger', 'TEXT'],
        ['http_status', 'INTEGER'],
        ['replay_of', 'TEXT'],
        ['listen', 'TEXT'],
        ['request_method', 'TEXT'],
        ['request_url', 'TEXT'],
        ['request_ctype', 'TEXT'],
        ['request_body', 'TEXT'],
        ['request_truncated', 'INTEGER DEFAULT 0'],
        ['spawned_by', 'TEXT'],
      ]],
    ];
    for (const [t, cols] of tableCols) {
      const have2 = new Set(
        (this.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
      );
      for (const [n, decl] of cols) if (!have2.has(n)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${n} ${decl}`);
    }
    const wanted: [string, string][] = [
      ['faked', 'INTEGER DEFAULT 0'],
      ['aborted', 'INTEGER DEFAULT 0'],
      ['replayed', 'INTEGER DEFAULT 0'],
      ['patched', 'INTEGER DEFAULT 0'],
      ['request_hash', 'TEXT'],
      ['kind', "TEXT NOT NULL DEFAULT 'llm'"],
      ['method', 'TEXT'],
      ['frames', 'TEXT'],
      ['response_tool_calls', 'TEXT'],
      ['rules_checked', 'INTEGER DEFAULT 0'],
      ['response_body', 'TEXT'],
      ['response_bytes', 'INTEGER'],
      ['body_truncated', 'INTEGER DEFAULT 0'],
    ];
    for (const [name, decl] of wanted) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE calls ADD COLUMN ${name} ${decl}`);
    }
    // 老运行没有组：每个运行自成一组。索引放这里而不是建表语句里 —— 老库在补列之前建不了
    this.db.exec(`
      UPDATE runs SET group_id = run_id WHERE group_id IS NULL AND parent_run_id IS NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_parent ON runs(parent_run_id);
      CREATE INDEX IF NOT EXISTS idx_runs_group ON runs(group_id);
    `);
  }

  /** 这个源文件有没有出现在任何一次调用的调用栈里 —— 源码回写只许碰这些文件 */
  seenInFrames(file: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM calls WHERE instr(frames, ?) > 0 LIMIT 1').get(JSON.stringify(file));
  }

  /** 返回写入后的自增 id，供 SSE 的 Last-Event-ID 续传用 */
  ingest(ev: AgentEvent): number {
    const info = this.db
      .prepare('INSERT INTO events (run_id, seq, ts, type, json) VALUES (?,?,?,?,?)')
      .run(ev.runId, ev.seq, ev.ts, ev.type, JSON.stringify(slimEvent(ev)));

    switch (ev.type) {
      case 'run.started':
        this.upsertRun(ev);
        break;
      case 'run.ended':
        this.db
          .prepare('UPDATE runs SET ended_at=?, exit_code=?, http_status=COALESCE(?, http_status) WHERE run_id=?')
          .run(ev.ts, ev.exitCode, ev.httpStatus ?? null, ev.runId);
        if (ev.request) {
          this.db
            .prepare(`UPDATE runs SET request_method=?, request_url=?, request_ctype=?, request_body=?, request_truncated=?
                      WHERE run_id=?`)
            .run(ev.request.method, ev.request.url, ev.request.contentType, ev.request.body, ev.request.truncated ? 1 : 0, ev.runId);
        }
        break;
      case 'run.listening': {
        this.ensureRun(ev.runId, ev.ts);
        const cur = (this.db.prepare('SELECT listen FROM runs WHERE run_id=?').get(ev.runId) as { listen: string | null } | undefined)?.listen;
        const ports: { port: number; host: string | null }[] = cur ? JSON.parse(cur) : [];
        if (!ports.some((p) => p.port === ev.port)) ports.push({ port: ev.port, host: ev.host });
        this.db.prepare('UPDATE runs SET listen=? WHERE run_id=?').run(JSON.stringify(ports), ev.runId);
        break;
      }
      case 'llm.before':
        this.insertCall(ev);
        break;
      case 'llm.patched':
        this.applyPatch(ev);
        break;
      case 'llm.after':
        this.completeCall(ev);
        break;
      case 'http.call':
        this.insertHttpCall(ev);
        break;
      case 'http.body':
        this.attachBody(ev);
        break;
    }
    return Number(info.lastInsertRowid);
  }

  private insertHttpCall(ev: HttpCall): void {
    this.ensureRun(ev.runId, ev.ts);
    this.db
      .prepare(
        `INSERT INTO calls
           (call_id, run_id, seq, kind, method, frames, url, provider, status, ok, duration_ms, error, started_at,
            response_body, response_bytes)
         VALUES (?,?,?,'http',?,?,?,'http',?,?,?,?,?,?,?)
         ON CONFLICT(call_id) DO NOTHING`,
      )
      .run(
        ev.callId,
        ev.runId,
        ev.seq,
        ev.method,
        JSON.stringify(ev.frames ?? []),
        ev.url,
        ev.status,
        ev.ok ? 1 : 0,
        ev.durationMs,
        ev.error,
        // http.call 是调用**结束后**才发的，ts 是结束时间；瀑布图要的是开始时间
        ev.startedAt ?? ev.ts - (ev.durationMs ?? 0),
        ev.responseBody ?? null,
        ev.responseBytes ?? null,
      );
  }

  private attachBody(ev: HttpBody): void {
    this.db
      .prepare('UPDATE calls SET response_body=?, response_bytes=?, body_truncated=? WHERE call_id=?')
      .run(ev.body, ev.bytes, ev.truncated ? 1 : 0, ev.callId);
  }

  private ensureRun(runId: string, ts: number): void {
    // 附着模式下可能收不到 run.started（进程先于服务端启动），补一条占位
    this.db
      .prepare('INSERT INTO runs (run_id, started_at, group_id) VALUES (?,?,?) ON CONFLICT(run_id) DO NOTHING')
      .run(runId, ts, runId);
  }

  /** 执行图的原料：一次运行里所有调用的调用路径 + 各自的开销 */
  callPaths(runId?: string): {
    kind: string;
    frames: string;
    duration_ms: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    ok: number | null;
  }[] {
    const cols = 'kind, frames, duration_ms, input_tokens, output_tokens, ok';
    return (
      runId
        ? this.db.prepare(`SELECT ${cols} FROM calls WHERE run_id IN ${SCOPE} ORDER BY seq`).all(...scope(runId))
        : this.db.prepare(`SELECT ${cols} FROM calls ORDER BY started_at DESC LIMIT 2000`).all()
    ) as never;
  }

  /**
   * run.started 可能晚于这次运行的第一个调用到达：请求级运行的 run.started 走异步上报队列，
   * 而第一次 LLM 调用走闸门直达。那时 ensureRun 已经插了一条占位行 —— 所以冲突时要
   * **补全**字段，而不是什么都不做（否则请求级运行会丢掉它的父运行和触发请求）。
   */
  private upsertRun(ev: RunStarted): void {
    const groupOf = (id: string) =>
      (this.db.prepare('SELECT group_id FROM runs WHERE run_id=?').get(id) as { group_id: string | null } | undefined)?.group_id ?? id;
    // 组：显式给的 > 父运行的组（请求挂进程）> 拉起它的运行的组（子进程挂父进程）> 自己
    const group = ev.groupId ??
      (ev.parentRunId ? groupOf(ev.parentRunId) : ev.spawnedBy ? groupOf(ev.spawnedBy) : ev.runId);
    this.db
      .prepare(
        `INSERT INTO runs (run_id, cwd, argv, pid, started_at, kind, parent_run_id, group_id, trigger, replay_of, spawned_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(run_id) DO UPDATE SET
           cwd = excluded.cwd, argv = excluded.argv, pid = excluded.pid,
           started_at = MIN(runs.started_at, excluded.started_at),
           kind = excluded.kind, parent_run_id = excluded.parent_run_id,
           group_id = excluded.group_id, trigger = excluded.trigger,
           -- run.started 里显式给的基线优先（回归请求带着精确的基线请求）；没给才保留查缓存时记下的
           replay_of = COALESCE(excluded.replay_of, runs.replay_of),
           spawned_by = excluded.spawned_by`,
      )
      .run(
        ev.runId, ev.cwd, JSON.stringify(ev.argv), ev.pid, ev.ts,
        ev.kind ?? 'process', ev.parentRunId ?? null, group, ev.trigger ?? null, ev.replayOf ?? null, ev.spawnedBy ?? null,
      );
    // 子进程可能比拉起它的运行先登记（事件经不同的连接到达）—— 那时只能先把组记成父运行的 id；
    // 父运行到了再把这些临时记下的（子进程以及子进程的子进程）改到正确的组。
    // 只改临时值：子进程自己显式给了 AGENTMAKE_GROUP 的不动
    if (group !== ev.runId) {
      this.db
        .prepare(`WITH RECURSIVE kids(id) AS (
                    SELECT run_id FROM runs WHERE spawned_by = ?
                    UNION SELECT r.run_id FROM runs r JOIN kids k ON r.spawned_by = k.id)
                  UPDATE runs SET group_id = ? WHERE run_id IN (SELECT id FROM kids) AND group_id = ?`)
        .run(ev.runId, group, ev.runId);
    }
  }

  /** 这次运行在用谁做重放基线。第一次查缓存时记下，之后不改 —— 用于对比时自动找基线 */
  noteReplayOf(runId: string, baseline: string): void {
    if (!runId || !baseline || runId === baseline) return;
    this.ensureRun(runId, Date.now());
    this.db.prepare('UPDATE runs SET replay_of=? WHERE run_id=? AND replay_of IS NULL').run(baseline, runId);
  }

  getRun(runId: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE run_id=?').get(runId) as RunRow | undefined;
  }

  /**
   * 对比时缺省的基线：B 的 replay_of。
   *
   * 基线若是一个进程（或组），而 B 是其中某个请求的重放，就按「同样的触发请求、第几次」
   * 在基线范围里找对应的那个请求：重启后的第 2 次 POST /api/dispatch 对上一轮的第 2 次。
   * 找不到同序号的就退到第一个同触发的，再不行就用整个基线范围。
   */
  resolveBaseline(runId: string): string | null {
    const b = this.getRun(runId);
    if (!b?.replay_of) return null;
    const base = b.replay_of;
    if (b.kind !== 'request' || !b.trigger) return base;
    const baseRun = this.getRun(base);
    if (baseRun?.kind === 'request') return base;

    const sameTrigger = (sql: string, args: unknown[]) =>
      (this.db.prepare(sql).all(...(args as never[])) as { run_id: string }[]).map((r) => r.run_id);
    const candidates = sameTrigger(
      `SELECT run_id FROM runs WHERE run_id IN ${SCOPE} AND kind='request' AND trigger=? ORDER BY ${ARRIVAL}`,
      [...scope(base), b.trigger],
    );
    if (!candidates.length) return base;
    const siblings = sameTrigger(
      `SELECT run_id FROM runs WHERE parent_run_id=? AND kind='request' AND trigger=? ORDER BY ${ARRIVAL}`,
      [b.parent_run_id, b.trigger],
    );
    const idx = siblings.indexOf(runId);
    return candidates[idx] ?? candidates[0];
  }

  private insertCall(ev: LLMBefore): void {
    const r = ev.request;
    this.ensureRun(ev.runId, ev.ts);

    this.db
      .prepare(
        `INSERT INTO calls
           (call_id, run_id, seq, kind, method, frames, url, provider, model, system, messages, tools, params, raw_request, started_at)
         VALUES (?,?,?,'llm','POST',?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(call_id) DO NOTHING`,
      )
      .run(
        ev.callId,
        ev.runId,
        ev.seq,
        JSON.stringify(ev.frames ?? []),
        ev.url,
        r.provider,
        r.model,
        r.system,
        JSON.stringify(r.messages),
        JSON.stringify(r.tools),
        JSON.stringify(r.params),
        JSON.stringify(r.raw),
        ev.ts,
      );
  }

  /** 断点改写后重写请求侧字段 —— 库里必须是**实际发出去**的那一份 */
  private applyPatch(ev: LLMPatched): void {
    const r = ev.request;
    this.db
      .prepare(
        `UPDATE calls SET model=?, system=?, messages=?, tools=?, params=?, raw_request=?, url=?, patched=1
         WHERE call_id=?`,
      )
      .run(
        r.model,
        r.system,
        JSON.stringify(r.messages),
        JSON.stringify(r.tools),
        JSON.stringify(r.params),
        JSON.stringify(r.raw),
        ev.url,
        ev.callId,
      );
  }

  private completeCall(ev: LLMAfter): void {
    const resp = ev.response;
    this.db
      .prepare(
        `UPDATE calls SET status=?, ok=?, duration_ms=?, response_text=?, response_tool_calls=?, finish_reason=?,
                          input_tokens=?, output_tokens=?, cache_read_tokens=?,
                          raw_response=?, error=?, streaming=?, faked=?, aborted=?,
                          replayed=?, request_hash=?
         WHERE call_id=?`,
      )
      .run(
        ev.status,
        ev.ok ? 1 : 0,
        ev.durationMs,
        resp?.text ?? null,
        resp?.toolCalls?.length ? JSON.stringify(resp.toolCalls) : null,
        resp?.finishReason ?? null,
        resp?.usage.inputTokens ?? null,
        resp?.usage.outputTokens ?? null,
        resp?.usage.cacheReadTokens ?? null,
        resp ? JSON.stringify(resp.raw) : null,
        ev.error,
        ev.streaming ? 1 : 0,
        ev.faked ? 1 : 0,
        ev.aborted ? 1 : 0,
        ev.replayed ? 1 : 0,
        ev.requestHash ?? null,
        ev.callId,
      );
    this.applyRules(ev.callId);
  }

  // ── 评分 ─────────────────────────────────────────────────

  /**
   * 对一次调用跑规则判定，结果写成 source=rule 的评分。
   * 先删后写：同一次调用可能完成两次（响应后断点改写了回答），判定要跟着最终版本走。
   */
  private applyRules(callId: string): void {
    const row = this.db
      .prepare(
        `SELECT run_id, kind, ok, status, faked, finish_reason, response_text, response_tool_calls, tools, streaming
         FROM calls WHERE call_id=?`,
      )
      .get(callId) as (RuleInput & { run_id: string }) | undefined;
    if (!row) return;
    this.db.prepare("DELETE FROM scores WHERE call_id=? AND source='rule'").run(callId);
    for (const h of checkCall(row)) {
      this.upsertScore({ runId: row.run_id, callId, name: h.name, passed: false, comment: h.comment, source: 'rule' });
    }
    this.db.prepare('UPDATE calls SET rules_checked=1 WHERE call_id=?').run(callId);
  }

  /** 老库里规则上线前就完成的调用补判一次，否则 find_failures 对历史运行是瞎的 */
  private backfillRules(): void {
    const ids = this.db
      .prepare("SELECT call_id FROM calls WHERE kind='llm' AND rules_checked=0 AND status IS NOT NULL")
      .all() as { call_id: string }[];
    if (!ids.length) return;
    this.db.exec('BEGIN');
    try {
      for (const { call_id } of ids) this.applyRules(call_id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 写入或覆盖一条评分。返回落库后的行；目标不存在时返回错误信息 */
  upsertScore(s: ScoreInput): ScoreRow | { error: string } {
    let runId = s.runId ?? null;
    const callId = s.callId ?? null;
    if (callId) {
      const c = this.db.prepare('SELECT run_id FROM calls WHERE call_id=?').get(callId) as { run_id: string } | undefined;
      if (!c) return { error: `没有这个调用：${callId}` };
      runId = c.run_id;
    } else if (!runId || !this.db.prepare('SELECT 1 FROM runs WHERE run_id=?').get(runId)) {
      return { error: runId ? `没有这个运行：${runId}` : '需要 callId 或 runId' };
    }
    if (!s.name) return { error: '需要 name' };
    const id = `${s.source}:${callId ?? `run:${runId}`}:${s.name}`;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO scores (score_id, run_id, call_id, name, passed, value, label, comment, source, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        runId,
        callId,
        s.name,
        s.passed == null ? null : s.passed ? 1 : 0,
        typeof s.value === 'number' && Number.isFinite(s.value) ? s.value : null,
        s.label ?? null,
        s.comment ?? null,
        s.source,
        Date.now(),
      );
    return this.db.prepare('SELECT * FROM scores WHERE score_id=?').get(id) as ScoreRow;
  }

  getScore(scoreId: string): ScoreRow | undefined {
    return this.db.prepare('SELECT * FROM scores WHERE score_id=?').get(scoreId) as ScoreRow | undefined;
  }

  deleteScore(scoreId: string): boolean {
    return Number(this.db.prepare('DELETE FROM scores WHERE score_id=?').run(scoreId).changes) > 0;
  }

  scores(q: { runId?: string; callId?: string }): ScoreRow[] {
    if (q.callId) {
      return this.db.prepare('SELECT * FROM scores WHERE call_id=? ORDER BY source, name').all(q.callId) as ScoreRow[];
    }
    if (q.runId) {
      return this.db
        .prepare(`SELECT * FROM scores WHERE run_id IN ${SCOPE} ORDER BY created_at`)
        .all(...scope(q.runId)) as ScoreRow[];
    }
    return this.db.prepare('SELECT * FROM scores ORDER BY created_at DESC LIMIT 200').all() as ScoreRow[];
  }

  /** 一次运行里每个调用的失败评分名 —— 运行对比和页面徽章用 */
  failingByCall(runId: string): Map<string, string[]> {
    const rows = this.db
      .prepare(`SELECT call_id, name FROM scores WHERE run_id IN ${SCOPE} AND passed=0 AND call_id IS NOT NULL ORDER BY name`)
      .all(...scope(runId)) as { call_id: string; name: string }[];
    const m = new Map<string, string[]>();
    for (const r of rows) m.set(r.call_id, [...(m.get(r.call_id) ?? []), r.name]);
    return m;
  }

  /** 运行的评分概况：多少调用被判失败、运行级的失败评分、各名字的次数 */
  scoreSummary(runId: string): { failedCalls: number; runFailures: string[]; byName: Record<string, number> } {
    const rows = this.db
      .prepare(`SELECT call_id, name FROM scores WHERE run_id IN ${SCOPE} AND passed=0`)
      .all(...scope(runId)) as { call_id: string | null; name: string }[];
    const byName: Record<string, number> = {};
    for (const r of rows) byName[r.name] = (byName[r.name] ?? 0) + 1;
    return {
      failedCalls: new Set(rows.filter((r) => r.call_id).map((r) => r.call_id)).size,
      runFailures: rows.filter((r) => !r.call_id).map((r) => r.name),
      byName,
    };
  }

  /**
   * 运行列表。进程运行的计数包含它下面的请求级运行 —— 常驻服务的进程自己几乎不发调用，
   * 只数自己的话列表上全是「0 次调用」。groupId 给了就只列这个组。
   */
  listRuns(limit = 50, groupId?: string): unknown[] {
    const mine = `(c.run_id = r.run_id OR c.run_id IN (SELECT x.run_id FROM runs x WHERE x.parent_run_id = r.run_id))`;
    return this.db
      .prepare(
        `SELECT r.*,
                (SELECT COUNT(*) FROM calls c WHERE ${mine}) AS call_count,
                (SELECT COALESCE(SUM(c.input_tokens),0) FROM calls c WHERE ${mine}) AS input_tokens,
                (SELECT COALESCE(SUM(c.output_tokens),0) FROM calls c WHERE ${mine}) AS output_tokens,
                (SELECT COUNT(*) FROM runs x WHERE x.parent_run_id = r.run_id) AS child_runs,
                (SELECT COUNT(DISTINCT COALESCE(s.call_id, 'run:' || s.run_id)) FROM scores s
                  WHERE s.passed = 0 AND (s.run_id = r.run_id
                    OR s.run_id IN (SELECT x.run_id FROM runs x WHERE x.parent_run_id = r.run_id))) AS failing
         FROM runs r ${groupId ? 'WHERE r.group_id = ?' : ''}
         ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(...((groupId ? [groupId, limit] : [limit]) as never[]));
  }

  /** 历史面板的原料：运行、每个运行的调用统计、判定失败数、第一条用户消息（任务原文） */
  historyRaw(maxRuns = 5000): {
    runs: HistoryRun[];
    stats: Map<string, RunStats>;
    failing: Map<string, number>;
    tasks: Map<string, string | null>;
  } {
    const runs = this.db
      .prepare(`SELECT run_id, kind, parent_run_id, spawned_by, group_id, trigger, cwd, argv, pid, started_at, ended_at, replay_of
                FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(maxRuns) as HistoryRun[];
    const stats = new Map<string, RunStats>();
    // 「失败」只算真失败：HTTP 层失败，或者有错误且没拿到结束信号 ——
    // 早先流式调用读完就被调用方 abort 的，会留下错误文本但 finish_reason 是全的，那不是失败
    for (const r of this.db
      .prepare(`SELECT run_id,
                       SUM(kind='llm') AS llm, SUM(kind!='llm') AS tool,
                       COALESCE(SUM(input_tokens),0) AS tokensIn, COALESCE(SUM(output_tokens),0) AS tokensOut,
                       SUM(ok=0 OR (error IS NOT NULL AND finish_reason IS NULL AND kind='llm')) AS errors,
                       SUM(duration_ms IS NULL) AS pending,
                       MIN(started_at) AS firstAt, MAX(started_at + COALESCE(duration_ms,0)) AS lastAt,
                       GROUP_CONCAT(DISTINCT model) AS models
                FROM calls GROUP BY run_id`)
      .all() as (RunStats & { run_id: string })[]) {
      stats.set(r.run_id, r);
    }
    const failing = new Map<string, number>();
    for (const r of this.db
      .prepare(`SELECT run_id, COUNT(DISTINCT COALESCE(call_id, 'run:' || run_id)) AS n FROM scores WHERE passed=0 GROUP BY run_id`)
      .all() as { run_id: string; n: number }[]) {
      failing.set(r.run_id, r.n);
    }
    // 每个运行最早那次模型调用里的第一条用户消息 —— 人靠它认出「这是哪一次」
    const tasks = new Map<string, string | null>();
    for (const r of this.db
      .prepare(`SELECT c.run_id, c.messages FROM calls c
                WHERE c.kind='llm' AND c.seq = (SELECT MIN(x.seq) FROM calls x WHERE x.run_id = c.run_id AND x.kind='llm')`)
      .all() as { run_id: string; messages: string | null }[]) {
      let text: string | null = null;
      try {
        const msgs = JSON.parse(r.messages ?? '[]') as { role: string; content: string }[];
        text = msgs.find((m) => m.role === 'user' && m.content)?.content ?? null;
      } catch {
        text = null;
      }
      tasks.set(r.run_id, text);
    }
    return { runs, stats, failing, tasks };
  }

  /** 运行组概况：一组里有几次运行、多少调用、多少判定失败 */
  listGroups(limit = 50): unknown[] {
    return this.db
      .prepare(
        `SELECT g.group_id,
                COUNT(*) AS runs,
                SUM(g.kind = 'request') AS request_runs,
                MIN(g.started_at) AS started_at,
                MAX(COALESCE(g.ended_at, g.started_at)) AS last_at,
                (SELECT COUNT(*) FROM calls c WHERE c.run_id IN (SELECT run_id FROM runs y WHERE y.group_id = g.group_id)) AS call_count,
                (SELECT COUNT(DISTINCT COALESCE(s.call_id, 'run:' || s.run_id)) FROM scores s
                  WHERE s.passed = 0 AND s.run_id IN (SELECT run_id FROM runs y WHERE y.group_id = g.group_id)) AS failing
         FROM runs g WHERE g.group_id IS NOT NULL
         GROUP BY g.group_id ORDER BY MAX(g.started_at) DESC LIMIT ?`,
      )
      .all(limit);
  }

  /** 列表视图故意不返回 raw_request / raw_response / frames —— 它们可能是几十 KB */
  listCalls(runId?: string, limit = 500, node?: string): unknown[] {
    // faked / replayed 必须带上：UI 靠它们显示徽章，漏了会导致刷新页面后徽章消失
    const cols = `call_id, run_id, seq, kind, method, url, provider, model, status, ok, duration_ms,
                  input_tokens, output_tokens, cache_read_tokens, ${ERROR_COL}, streaming,
                  faked, replayed, patched, request_hash, started_at,
                  (SELECT group_concat(s.name) FROM scores s
                    WHERE s.call_id = calls.call_id AND s.passed = 0) AS failing,
                  substr(COALESCE(system,''), 1, 160)        AS system_preview,
                  substr(COALESCE(NULLIF(response_text,''), response_tool_calls, ''), 1, 240) AS response_preview`;
    let rows = (
      runId
        ? this.db.prepare(`SELECT ${cols}, frames FROM calls WHERE run_id IN ${SCOPE} ORDER BY seq LIMIT ?`).all(...scope(runId), limit)
        : this.db.prepare(`SELECT ${cols}, frames FROM calls ORDER BY started_at DESC LIMIT ?`).all(limit)
    ) as Record<string, unknown>[];

    // 按执行图节点过滤：点画布上一个函数，只看它（及其下游）发出的调用
    if (node) {
      rows = rows.filter((r) => {
        try {
          return (JSON.parse(String(r.frames ?? '[]')) as { file: string; fn: string }[]).some(
            (f) => `${f.file}#${f.fn}` === node,
          );
        } catch {
          return false;
        }
      });
    }
    for (const r of rows) delete r.frames;
    return rows;
  }

  getCall(callId: string): unknown {
    const c = this.db.prepare('SELECT * FROM calls WHERE call_id=?').get(callId) as Record<string, unknown> | undefined;
    // 同 ERROR_COL：成功且收到结束信号的，残留的「aborted」不算错误
    if (c && c.ok === 1 && c.finish_reason != null && c.error != null) c.error = null;
    return c;
  }

  /** 全文搜索 prompt / 响应。给 MCP 用 —— AI 常常是「我记得有句话…」这样找起的 */
  searchCalls(q: string, runId?: string, limit = 20): unknown[] {
    const like = `%${q}%`;
    const where = runId ? `AND run_id IN ${SCOPE}` : '';
    const args: unknown[] = [like, like, like, like];
    if (runId) args.push(...scope(runId));
    args.push(limit);
    return this.db
      .prepare(
        `SELECT call_id, run_id, seq, kind, provider, model, status, ok, duration_ms,
                input_tokens, output_tokens, started_at,
                substr(COALESCE(system,''),1,120)        AS system_preview,
                substr(COALESCE(response_text,''),1,160) AS response_preview
         FROM calls
         WHERE (system LIKE ? OR messages LIKE ? OR response_text LIKE ? OR response_tool_calls LIKE ?) ${where}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(...(args as never[]));
  }

  /**
   * 重放查询：在基线运行里找指纹相同、且真的拿到过响应的调用。
   *
   * 排除 replayed=1 的行不是洁癖 —— 那些行的 raw_response 是从更早的运行复制来的，
   * 允许它们做基线会让缓存无限自我传递，越跑越难判断「这份响应到底出自哪次真实调用」。
   */
  // ── 规格 ──────────────────────────────────────────────────

  getSpec(name: string): unknown | null {
    const r = this.db.prepare('SELECT json FROM specs WHERE name=?').get(name) as
      | { json: string }
      | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.json);
    } catch {
      return null;
    }
  }

  putSpec(name: string, spec: unknown): void {
    this.db
      .prepare(
        `INSERT INTO specs (name, json, updated_at) VALUES (?,?,?)
         ON CONFLICT(name) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at`,
      )
      .run(name, JSON.stringify(spec), Date.now());
  }

  listSpecs(): { name: string; updated_at: number }[] {
    return this.db.prepare('SELECT name, updated_at FROM specs ORDER BY updated_at DESC').all() as never;
  }

  deleteSpec(name: string): void {
    this.db.prepare('DELETE FROM specs WHERE name=?').run(name);
  }

  /**
   * 基线可以是单次运行、进程运行（连同它的请求级运行）或运行组 —— 常驻服务重启后重放，
   * 要在「上一个进程处理过的任何一个请求」里找同一个调用。
   */
  findReplay(baselineRunId: string, hash: string): { raw_response: string; status: number; streaming: number } | undefined {
    return this.db
      .prepare(
        `SELECT raw_response, status, streaming FROM calls
         WHERE run_id IN ${SCOPE} AND request_hash=? AND ok=1 AND replayed=0 AND raw_response IS NOT NULL
         ORDER BY seq LIMIT 1`,
      )
      .get(...scope(baselineRunId), hash) as never;
  }

  /** 两次运行的 LLM 调用（按顺序），供对比用 */
  llmCallsFor(runId: string): any[] {
    return this.db
      .prepare(
        `SELECT call_id, seq, provider, model, request_hash, frames,
                system, messages, response_text, response_tool_calls, input_tokens, output_tokens,
                duration_ms, ok, replayed, error
         FROM calls WHERE run_id IN ${SCOPE} AND kind='llm' ORDER BY seq`,
      )
      .all(...scope(runId)) as never;
  }

  /** 语义流程图的原料：按执行顺序的全部调用 */
  flowCalls(runId?: string): unknown[] {
    const cols = `call_id, run_id, seq, kind, provider, model, url, method, frames,
                  system, messages, response_text, response_tool_calls, duration_ms,
                  input_tokens, output_tokens, ok, ${ERROR_COL}, started_at, request_hash, replayed,
                  response_body, response_bytes, body_truncated`;
    const rid = runId ?? this.latestRunId();
    if (!rid) return [];
    return this.db.prepare(`SELECT ${cols} FROM calls WHERE run_id IN ${SCOPE} ORDER BY seq`).all(...scope(rid));
  }

  /** 完整记录（transcript.ts）的原料：这个范围里的全部调用，按发出的先后。工具响应体只带开头一段做预览 */
  transcriptCalls(runId: string): TranscriptCall[] {
    return this.db
      .prepare(`SELECT call_id, run_id, kind, model, url, method, status, ok, ${ERROR_COL}, system, messages,
                       response_text, response_tool_calls, finish_reason, duration_ms, input_tokens, output_tokens,
                       cache_read_tokens, started_at, substr(response_body, 1, 400) AS response_preview, response_bytes
                FROM calls WHERE run_id IN ${SCOPE} ORDER BY started_at, seq`)
      .all(...scope(runId)) as TranscriptCall[];
  }

  /** 一次运行（不含子运行）按顺序的全部调用 —— 拆 prompt 来源时，上游只在同一次运行里找 */
  callsOfRun(runId: string): unknown[] {
    const cols = `call_id, run_id, seq, kind, provider, model, url, method, frames,
                  system, messages, response_text, response_tool_calls, duration_ms,
                  input_tokens, output_tokens, ok, ${ERROR_COL}, started_at, request_hash, replayed,
                  response_body, response_bytes, body_truncated, status`;
    return this.db.prepare(`SELECT ${cols} FROM calls WHERE run_id=? ORDER BY seq`).all(runId);
  }

  /** 一个范围（进程 / 组）下的请求级运行，按到达顺序 —— 批量回归从这里挑请求重发 */
  requestRuns(scopeId: string): any[] {
    return this.db
      .prepare(`SELECT * FROM runs WHERE run_id IN ${SCOPE} AND kind='request' ORDER BY ${ARRIVAL}`)
      .all(...scope(scopeId)) as never;
  }

  /** 基线进程之后起来、还在跑、在监听端口的进程 —— 批量回归的缺省目标（同一个工作目录） */
  findTarget(baselineId: string): any {
    const base = this.getRun(baselineId) as (RunRow & { cwd?: string | null; parent_run_id: string | null }) | undefined;
    if (!base) return undefined;
    const proc = base.kind === 'request' && base.parent_run_id ? this.getRun(base.parent_run_id) : base;
    return this.db
      .prepare(`SELECT * FROM runs WHERE kind='process' AND listen IS NOT NULL AND ended_at IS NULL
                AND run_id != ? AND started_at >= ? AND (cwd IS ? OR cwd = ?)
                ORDER BY started_at DESC LIMIT 1`)
      .get(proc!.run_id, proc!.started_at, (proc as never as { cwd: string | null }).cwd, (proc as never as { cwd: string | null }).cwd);
  }

  /** 回归重发后，目标进程里对应这个基线请求的新运行 */
  findReplayRun(baselineRun: string, targetProcess: string, after: number): any {
    return this.db
      .prepare(`SELECT * FROM runs WHERE replay_of=? AND parent_run_id=? AND started_at >= ? ORDER BY started_at DESC LIMIT 1`)
      .get(baselineRun, targetProcess, after);
  }

  /** 运行 id → 触发它的入站请求（对比表上每行标着是哪个请求） */
  triggers(runIds: string[]): Map<string, string | null> {
    const m = new Map<string, string | null>();
    if (!runIds.length) return m;
    const rows = this.db
      .prepare(`SELECT run_id, trigger FROM runs WHERE run_id IN (${runIds.map(() => '?').join(',')})`)
      .all(...runIds) as { run_id: string; trigger: string | null }[];
    for (const r of rows) m.set(r.run_id, r.trigger);
    return m;
  }

  /** 循环事件：轮次、退出原因、上限覆写。seq 保留 —— 要靠它和调用交错还原「第几轮」 */
  loopEvents(runId?: string): unknown[] {
    const rid = runId ?? this.latestRunId();
    if (!rid) return [];
    const rows = this.db
      .prepare(`SELECT type, seq, ts, json FROM events WHERE run_id IN ${SCOPE} AND type LIKE 'loop.%' ORDER BY seq`)
      .all(...scope(rid)) as { type: string; seq: number; ts: number; json: string }[];
    const out: unknown[] = [];
    for (const r of rows) {
      try {
        const e = JSON.parse(r.json);
        out.push({
          type: r.type,
          seq: r.seq,
          ts: r.ts,
          loopId: e.loopId,
          runId: e.runId ?? null,
          iteration: e.iteration ?? null,
          iterations: e.iterations ?? null,
          reason: e.reason ?? null,
          endLine: e.endLine ?? null,
          maxOverride: e.maxOverride ?? null,
        });
      } catch {
        /* 坏行跳过，不该因为一条事件毁掉整张图 */
      }
    }
    return out;
  }

  // ── 项目 ──────────────────────────────────────────────────

  listProjects(): unknown[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all();
  }

  getProject(id: string): unknown {
    return this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  }

  putProject(p: {
    id: string; name: string; dir: string; kind: string;
    cmd: string; trigger?: string | null; createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, dir, kind, cmd, trigger, created_at) VALUES (?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, dir=excluded.dir, kind=excluded.kind,
                                       cmd=excluded.cmd, trigger=excluded.trigger`,
      )
      .run(p.id, p.name, p.dir, p.kind, p.cmd, p.trigger ?? null, p.createdAt);
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
  }

  /** 某个目录下最近一次运行 —— 项目卡片上的「重放上次」拿它当基线 */
  lastRunIn(dir: string): string | null {
    const r = this.db
      .prepare('SELECT run_id FROM runs WHERE cwd=? ORDER BY started_at DESC LIMIT 1')
      .get(dir) as { run_id: string } | undefined;
    return r?.run_id ?? null;
  }

  /** 这次运行的进程是不是已经退出了 */
  runEnded(runId: string): boolean {
    const r = this.db.prepare('SELECT ended_at FROM runs WHERE run_id=?').get(runId) as
      | { ended_at: number | null }
      | undefined;
    return !!r?.ended_at;
  }

  /** 最近一次运行 —— 流程图默认只画它，混着画互不相干的进程没有意义 */
  latestRunId(): string | null {
    const r = this.db.prepare('SELECT run_id FROM runs ORDER BY started_at DESC LIMIT 1').get() as
      | { run_id: string }
      | undefined;
    return r?.run_id ?? null;
  }

  /**
   * 失败的调用 —— find_failures 的数据源。
   *
   * 两类失败合在一起：HTTP 层的（ok=0 / error），和评分判定的（规则 / AI / 人判 passed=0）。
   * 后者是 200 但答坏了的那种，只看状态码永远找不到。每行带上 failing[]：为什么算失败。
   * 运行级的失败评分没有对应调用，以 kind='run' 的行出现。
   */
  failures(runId?: string, limit = 20): unknown[] {
    const where = runId ? `c.run_id IN ${SCOPE} AND` : '';
    const rows = this.db
      .prepare(
        `SELECT c.call_id, c.run_id, c.seq, c.kind, c.method, c.url, c.provider, c.model,
                c.status, c.ok, c.duration_ms, c.error, c.frames, c.started_at
         FROM calls c
         WHERE ${where} (c.ok = 0 OR c.error IS NOT NULL
                OR EXISTS (SELECT 1 FROM scores s WHERE s.call_id = c.call_id AND s.passed = 0))
         ORDER BY c.started_at DESC LIMIT ?`,
      )
      .all(...((runId ? [...scope(runId), limit] : [limit]) as never[])) as Record<string, unknown>[];

    const failing = this.db.prepare(
      'SELECT name, source, comment, value, label FROM scores WHERE call_id=? AND passed=0 ORDER BY source, name',
    );
    for (const r of rows) r.failing = failing.all(String(r.call_id));

    const runLevel = this.db
      .prepare(
        `SELECT run_id, name, source, comment, value, label, created_at FROM scores
         WHERE call_id IS NULL AND passed=0 ${runId ? `AND run_id IN ${SCOPE}` : ''} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...((runId ? [...scope(runId), limit] : [limit]) as never[])) as Record<string, unknown>[];
    const runRows = runLevel.map((s) => ({
      call_id: null, run_id: s.run_id, kind: 'run', started_at: s.created_at,
      failing: [{ name: s.name, source: s.source, comment: s.comment, value: s.value, label: s.label }],
    }));
    return [...runRows, ...rows];
  }

  eventsSince(afterId: number, limit = 1000): { id: number; json: string }[] {
    return this.db
      .prepare('SELECT id, json FROM events WHERE id > ? ORDER BY id LIMIT ?')
      .all(afterId, limit) as { id: number; json: string }[];
  }
}
