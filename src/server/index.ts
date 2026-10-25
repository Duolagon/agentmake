// Debugger Server —— 事件接收 + 存储 + SSE 广播 + 静态页面。
//
// 只监听 127.0.0.1：这是本地自用工具，不该出现在任何网卡上。
// 不用 express —— node:http 够了，少一个依赖少一份供应链风险。

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { slimEvent, Store } from './store.ts';
import { buildGraph } from './graph.ts';
import { compareRuns } from './compare.ts';
import { buildFlow } from './flow.ts';
import { computeAnomalies } from './anomalies.ts';
import { anatomize } from './anatomy.ts';
import { stepCompare } from './stepcompare.ts';
import { diffLines, verifyRuns } from './verify.ts';
import { getBatch, listBatches, startRegression } from './regress.ts';
import { messageFullText, toolCallText } from '../shared/tooltext.ts';
import { handleProxy, proxyHelp } from './proxy.ts';
import { emptySpec, reconcile, specFromFlow } from './spec.ts';
import { hookBefore, hookAfter } from './hook.ts';
import * as projects from './projects.ts';
import type { Spec } from './spec.ts';
import { analyze } from './writability.ts';
import { applyEdit, applyEdits, backupOf, revert } from './patch.ts';
import { Gate } from './gate.ts';
import { langfuseTracer } from './langfuse.ts';
import { buildHistory } from './history.ts';
import { buildLoopMap, buildTiming, buildTranscript } from './transcript.ts';

/** 进程还在不在（同一台机器）。被杀掉的进程收不到 run.ended，不能一直显示「在跑」 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'; // 在，只是不是我们的进程
  }
}
import type { GatePhase } from './gate.ts';
import type { AgentEvent } from '../shared/types.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, '../../web');
const DB_FILE = process.env.AGENTMAKE_DB || path.resolve(HERE, '../../.agentmake/agentmake.db');
const PORT = Number(process.env.AGENTMAKE_PORT || 8787);

// 循环多久没动静就不再算「正在转」。取 20 秒：agent 的一轮里通常有一次模型调用
// （几百毫秒到几秒），20 秒没进新的一轮，基本可以断定它不转了。
const LOOP_IDLE_MS = Number(process.env.AGENTMAKE_LOOP_IDLE_MS ?? 20_000);

const store = new Store(DB_FILE);
const gate = new Gate();

// 循环状态：覆写（改上限/跳出/再来一轮）、已见到的循环、停在轮次边界上的等待者
const loopOverrides = new Map<string, Record<string, unknown>>();
const loopSeen = new Map<string, { loopId: string; runId: string; iteration: number; at: number }>();
const loopWaiters = new Map<string, (d: { action?: string }) => void>();

/**
 * 取出覆写并消费掉一次性标志。
 *
 * breakNow / forceOneMore 必须在**服务端**清除：早期版本在 harness 侧清，
 * 但服务端还留着，于是每轮又被推回来 —— forceOneMore 变成「永远再来一轮」，
 * 循环停不下来（当时是靠 harness 的轮询上限才刹住）。
 */
function takeOverride(loopId: string): Record<string, unknown> | null {
  const o = loopOverrides.get(loopId);
  if (!o) return null;
  const snapshot = { ...o };
  if (o.breakNow || o.forceOneMore) {
    loopOverrides.set(loopId, { ...o, breakNow: false, forceOneMore: false });
    broadcastRaw({ type: 'loop.override', loopId, override: loopOverrides.get(loopId) });
  }
  return snapshot;
}

/**
 * 一次运行的语义流程图 + 循环的实时控制状态。
 *
 * 流程图接口和对账接口都要它，而且必须是同一份 —— 对账拿到的实际图要是少了
 * 循环覆写状态，「你预期 5 轮实际 12 轮」这类结论就会对着错的数字下。
 */
function flowFor(runId: string) {
  const flow = buildFlow(store.flowCalls(runId) as never, store.loopEvents(runId) as never, runId);
  // 规则判定画到图上：每次调用挂上它的失败名，步骤上按名字计数
  const failing = store.failingByCall(runId);
  for (const s of flow.steps) {
    for (const sp of s.spans) {
      sp.failing = failing.get(sp.callId) ?? [];
      for (const n of sp.failing) s.failing[n] = (s.failing[n] ?? 0) + 1;
    }
  }
  // 进程已经退出的运行，循环不可能还「正在转」。
  // loop.exited 只在循环正常走完时才发 —— 进程被 kill、抛异常跳出、或者最后一轮
  // 还没结束就退出，这条事件都不会来，循环会永远显示成「正在转」。
  const ended = store.runEnded(runId);
  for (const l of flow.loops) {
    // 「正在转」只在真的还在转的时候说。两种情况会让它永远卡在这个状态：
    //   1. 进程退出了 —— loop.exited 根本没机会发
    //   2. 循环体里抛了异常跳出去 —— 同样发不出 loop.exited
    // 第 2 种在长驻服务上尤其常见（服务不退出，循环却早就结束了），
    // 所以再加一条：一段时间没动静就不再声称它在转。
    const stale = l.lastSeen > 0 && Date.now() - l.lastSeen > LOOP_IDLE_MS;
    if (ended || stale) l.running = false;
    const o = loopOverrides.get(l.id) ?? {};
    (l as never as Record<string, unknown>).override = o;
    (l as never as Record<string, unknown>).pausedAt = loopWaiters.has(l.id)
      ? (loopSeen.get(l.id)?.iteration ?? null)
      : null;
    if (o.maxIterations != null) l.maxOverride = Number(o.maxIterations);
  }
  return flow;
}

/**
 * 流程图 + 自动发现的异常。
 *
 * 「比平时」的参照：看单个请求时用它所在进程的全部请求，否则用自己。
 */
function flowWithAnomalies(runId: string) {
  const flow = flowFor(runId);
  const calls = store.flowCalls(runId) as never;
  const loopEvents = store.loopEvents(runId) as never;
  const run = store.getRun(runId);
  const baseId = run?.kind === 'request' && run.parent_run_id ? run.parent_run_id : null;
  const anomalies = computeAnomalies({
    flow,
    calls,
    loopEvents,
    baselineCalls: baseId ? (store.flowCalls(baseId) as never) : undefined,
    baselineLoopEvents: baseId ? (store.loopEvents(baseId) as never) : undefined,
  });
  return { ...flow, anomalies };
}

/** flowWithAnomalies 返回的是「流程图 + anomalies」摊平的一个对象；验证要的是两样分开 */
function analyzed(id: string) {
  const f = flowWithAnomalies(id);
  return { flow: f, anomalies: f.anomalies };
}

function verifyFor(a: string, b: string) {
  return verifyRuns({ id: a, ...analyzed(a) }, { id: b, ...analyzed(b) });
}

const regressDeps = {
  requestRuns: (s: string) => store.requestRuns(s),
  getRun: (id: string) => store.getRun(id) as never,
  findTarget: (b: string) => store.findTarget(b),
  findReplayRun: (b: string, t: string, after: number) => store.findReplayRun(b, t, after),
  analyze: (id: string) => analyzed(id),
  verify: (a: string, b: string) => verifyFor(a, b),
  broadcast: (ev: Record<string, unknown>) => broadcastRaw(ev),
};

/** prompt 的「行」：system 每行、每条消息每行（带角色）—— 差异按行算，人一眼看出多了哪几条 */
function promptLines(c: Record<string, string>): string[] {
  const out: string[] = [];
  if (c.system) out.push(...c.system.split('\n').map((l) => `system │ ${l}`));
  let msgs: never[] = [];
  try { msgs = JSON.parse(c.messages || '[]'); } catch { /* ignore */ }
  for (const m of msgs as { role: string }[]) {
    out.push(...messageFullText(m as never).split('\n').map((l) => `${m.role} │ ${l}`));
  }
  return out;
}

function outputLines(c: Record<string, string>): string[] {
  let calls: never[] = [];
  try { calls = JSON.parse(c.response_tool_calls || '[]') ?? []; } catch { /* ignore */ }
  return [...(c.response_text ?? '').split('\n'), ...calls.map((x) => `→ ${toolCallText(x)}`)].filter((l) => l !== '');
}

/** 事件既要落库又要广播，且要拿到自增 id 供 SSE 续传 —— 收敛成一处 */
function record(ev: AgentEvent): void {
  broadcast(store.ingest(ev), slimEvent(ev));
  // Langfuse 导出是只读旁路：它自己的失败（含未配置/缺依赖）不影响落库与广播
  langfuseTracer.onEvent(ev);
  // 规则判定在落库时同步跑完；判出问题就告诉页面，列表上立刻打红标
  if (ev.type === 'llm.after') broadcastScores(ev.runId, ev.callId);
}

/**
 * 查重放缓存，顺带记下「这次运行以谁为基线」。三种接入方式（Node harness、Python 钩子、代理）
 * 都从这里过，于是基线关联不用在每个 harness 里各写一遍。
 */
function replayFor(baseline: string, hash: string, runId?: string | null): { body: string; status: number; ctype: string } | null {
  if (runId) store.noteReplayOf(runId, baseline);
  const hit = store.findReplay(baseline, hash);
  if (!hit) return null;
  // 流式调用存的 raw 是原始 SSE 文本（落库时 JSON 字符串化了一层）—— 解开，按流回放
  if (hit.streaming) {
    let sse = hit.raw_response;
    try { const v = JSON.parse(sse); if (typeof v === 'string') sse = v; } catch { /* 本来就是文本 */ }
    return { body: sse, status: hit.status, ctype: 'text/event-stream' };
  }
  return { body: hit.raw_response, status: hit.status, ctype: 'application/json' };
}

function broadcastScores(runId: string, callId: string | null): void {
  const failing = callId ? (store.failingByCall(runId).get(callId) ?? []) : [];
  broadcastRaw({ type: 'scores', runId, callId, failing });
}

// ── SSE 订阅者 ─────────────────────────────────────────────
const subscribers = new Set<http.ServerResponse>();

function broadcast(id: number, ev: AgentEvent): void {
  push(`id: ${id}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** 控制面事件（暂停/恢复/断点变更）—— 不落库，只推给页面 */
function broadcastRaw(ev: Record<string, unknown>): void {
  push(`data: ${JSON.stringify(ev)}\n\n`);
}

function push(frame: string): void {
  for (const res of subscribers) {
    try {
      res.write(frame);
    } catch {
      subscribers.delete(res);
    }
  }
}

// ── 路由 ───────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** 请求本身有问题（坏 JSON）—— 回 400，不是服务出错的 500 */
class BadRequest extends Error {}

/** 读请求体并解析成 JSON。解析失败是调用方的错，单独标出来，别和服务内部的解析错误混在一起 */
async function readJson(req: http.IncomingMessage): Promise<any> {
  const text = await readBody(req);
  if (!text.trim()) return {}; // 空请求体当空对象：各路由自己检查缺了哪个字段
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new BadRequest(`请求体不是合法的 JSON：${e instanceof Error ? e.message : e}`);
  }
}

async function readBody(req: http.IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new Error('payload too large');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 只服务本机。这个服务能改写源码、启动进程，必须挡住两类请求：
 *   · Host 不是本机地址 —— DNS 重绑定：外站把自己的域名解析到 127.0.0.1，浏览器就把它当同源
 *   · 带了外站 Origin 的写请求 —— 网页里一个 fetch(…, {method:'POST', mode:'no-cors'}) 就能打过来
 * harness / MCP / curl 不带 Origin，不受影响。
 */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
function localOnly(req: http.IncomingMessage): string | null {
  const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
  if (host && !LOCAL_HOSTS.has(host)) return `拒绝：Host ${req.headers.host} 不是本机地址`;
  const origin = req.headers.origin;
  if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
    let o: URL | null = null;
    try { o = new URL(origin); } catch { /* 畸形 Origin 一律当外站 */ }
    if (!o || !LOCAL_HOSTS.has(o.hostname === '::1' ? '[::1]' : o.hostname) || Number(o.port || 80) !== PORT) {
      return `拒绝：来自 ${origin} 的写请求`;
    }
  }
  return null;
}

/**
 * 回写 / 还原只允许碰「被调试程序的调用栈里出现过的源文件」—— 正常流程里，可回写性分析给出的
 * 文件本来就来自调用栈，所以这条限制对正常用法透明，却能挡住拿这个接口去写任意文件。
 */
function writableSource(file: unknown): string | null {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return '文件路径必须是绝对路径';
  if (!/\.(mjs|cjs|js)$/.test(file)) return '只能回写 .js / .mjs / .cjs 源文件';
  if (!store.seenInFrames(path.resolve(file))) return '只能回写被调试程序调用栈里出现过的源文件';
  return null;
}

const server = http.createServer(async (req, res) => {
  // URL 只取路径，基址写死：畸形 Host 让 new URL 抛错时，这里在 try 之外，会把整个服务带崩
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://127.0.0.1');
  } catch {
    return json(res, { error: 'bad request' }, 400);
  }
  const route = url.pathname;
  /** 正整数查询参数：缺了、写错了（limit=abc）、负数都用缺省值，太大的截到上限 —— 不让它变成 500 */
  const intParam = (name: string, def: number, max: number): number => {
    const v = Number(url.searchParams.get(name));
    return Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : def;
  };

  const denied = localOnly(req);
  if (denied) return json(res, { error: denied }, 403);

  try {
    // ── LLM 代理层：任何语言的 agent 只改 base URL 就能接进来 ──
    if (route === '/p' || route.startsWith('/p/')) {
      return handleProxy(req, res, url, {
        gate,
        record,
        broadcastRaw,
        replay: (baseline, hash, runId) => replayFor(baseline, hash, runId),
      });
    }

    // ── 语言无关的 harness 钩子：Python / Go / 任何能发 HTTP 的宿主 ──
    // 客户端只管抓栈和拦 HTTP，协议识别、归一化、指纹、断点决策全在这边做。
    if ((route === '/api/hook/before' || route === '/api/hook/after') && req.method === 'POST') {
      const hookCtx = {
        gate,
        record,
        broadcastRaw,
        replay: (baseline: string, hash: string, runId?: string) => replayFor(baseline, hash, runId),
      };
      const payload = (await readJson(req));
      return json(
        res,
        route.endsWith('before')
          ? await hookBefore(hookCtx, payload)
          : await hookAfter(hookCtx, payload),
      );
    }

    // ── harness 上报 ──
    if (route === '/ingest' && req.method === 'POST') {
      const { events } = (await readJson(req)) as { events: AgentEvent[] };
      for (const ev of events ?? []) record(ev);
      // 顺带把断点状态捎回去：harness 用它决定普通 HTTP 调用要不要走闸门。
      // HTTP 调用量可能上千，全部走闸门会白白多出上千次往返。
      return json(res, { ok: true, httpArmed: gate.httpArmed });
    }

    // ── 断点闸门：命中时这个响应会一直悬着，被调试进程正阻塞在它上面 ──
    if (route === '/api/gate' && req.method === 'POST') {
      const { event, phase } = (await readJson(req)) as {
        event: AgentEvent;
        phase: GatePhase;
      };
      record(event); // 先落库广播，页面才能显示「停在哪一次调用上」

      const ev = event as never as {
        callId: string; runId: string; url: string;
        request?: unknown; response?: unknown; frames?: never[];
      };
      const call = {
        callId: ev.callId,
        runId: ev.runId,
        phase,
        url: ev.url ?? '',
        payload: phase.endsWith('.before') ? ev.request : ev.response,
        frames: ev.frames ?? [],
        since: Date.now(),
      };
      const { held, decision, bpChanged } = gate.request(call);

      if (bpChanged) broadcastRaw({ type: 'breakpoints', ...gate.breakpoints });
      if (held) {
        broadcastRaw({ type: 'paused', callId: ev.callId, phase, runId: ev.runId, ts: Date.now() });
        // 客户端断开（被调试进程被 kill）时释放，避免 waiter 泄漏
        req.on('close', () => gate.resolve(ev.callId, phase, { action: 'continue' }));
      }

      const d = await decision;
      if (held) {
        broadcastRaw({ type: 'resumed', callId: ev.callId, phase, action: d.action, ts: Date.now() });
        broadcastRaw({ type: 'httpArmed', value: gate.httpArmed });
      }
      return json(res, d);
    }

    // ── 断点配置与决策 ──
    if (route === '/api/breakpoints') {
      if (req.method === 'POST') {
        const patch = (await readJson(req));
        const bp = gate.setBreakpoints(patch);
        // 全关时必须放行已挂起的调用，否则被调试进程永远卡在那里
        if (!gate.anyArmed) gate.releaseAll();
        broadcastRaw({ type: 'breakpoints', ...bp });
        return json(res, bp);
      }
      return json(res, { ...gate.breakpoints, pending: gate.listPending() });
    }

    if (route === '/api/resume' && req.method === 'POST') {
      const { callId, phase, armNext, ...decision } = (await readJson(req));
      const ok = gate.resolve(callId, phase ?? 'llm.before', decision);
      // 单步：放行后立刻在下一次同类调用上再停一次
      if (armNext) {
        const key = String(phase ?? 'llm.before').startsWith('llm') ? 'llmBefore' : 'httpBefore';
        const bp = gate.setBreakpoints({ [key]: true, once: true });
        broadcastRaw({ type: 'breakpoints', ...bp });
      }
      return json(res, { ok });
    }

    // ── SSE 实时事件流 ──
    if (route === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');

      // 断线续传：补发 Last-Event-ID 之后遗漏的事件，再接实时流
      const last = Number(req.headers['last-event-id'] ?? url.searchParams.get('lastEventId') ?? 0);
      // 分页补到最新为止 —— 只补一页的话，断线期间超过一页的事件就永远丢了。
      // 整段是同步的，补完之前不会插进实时事件，接上实时流时不重不漏。
      if (Number.isFinite(last) && last > 0) {
        for (let from = last; ;) {
          const page = store.eventsSince(from);
          for (const row of page) res.write(`id: ${row.id}\ndata: ${row.json}\n\n`);
          if (page.length < 1000) break;
          from = page[page.length - 1].id;
        }
      }

      subscribers.add(res);
      const hb = setInterval(() => {
        try {
          res.write(': keepalive\n\n');
        } catch {
          /* ignore */
        }
      }, 15_000);
      hb.unref?.();
      req.on('close', () => {
        clearInterval(hb);
        subscribers.delete(res);
      });
      return;
    }

    // ── 项目：导入目录 → 认出入口 → 在页面上直接启动 ──
    if (route === '/api/fs') {
      return json(res, await projects.listDir(url.searchParams.get('path') ?? undefined));
    }

    if (route === '/api/projects') {
      if (req.method === 'POST') {
        const body = (await readJson(req)) as {
          dir?: string; id?: string; cmd?: string; name?: string; trigger?: string;
        };
        if (body.id) {
          // 改命令 / 改名字
          const cur = store.getProject(body.id) as never as projects.Project | undefined;
          if (!cur) return json(res, { error: '没有这个项目' }, 404);
          const next = { ...cur, createdAt: (cur as never as { created_at: number }).created_at };
          if (body.cmd != null) next.cmd = body.cmd;
          if (body.trigger != null) next.trigger = body.trigger;
          if (body.name) next.name = body.name;
          store.putProject(next);
          broadcastRaw({ type: 'projects' });
          return json(res, next);
        }
        if (!body.dir) return json(res, { error: '要给一个目录' }, 400);
        const det = await projects.detect(body.dir);
        const p = {
          id: `p_${Date.now().toString(36)}`,
          name: body.name || body.dir.split('/').filter(Boolean).pop() || body.dir,
          dir: body.dir,
          kind: det.kind,
          cmd: body.cmd ?? det.cmd,
          trigger: body.trigger ?? null,
          createdAt: Date.now(),
        };
        store.putProject(p);
        broadcastRaw({ type: 'projects' });
        return json(res, { ...p, note: det.note });
      }
      if (req.method === 'DELETE') {
        const id = url.searchParams.get('id') ?? '';
        projects.stop(id);
        store.deleteProject(id);
        broadcastRaw({ type: 'projects' });
        return json(res, { ok: true });
      }
      // 列表带上进程状态：页面要显示 ▶ 还是 ■
      const rows = (store.listProjects() as never as Record<string, unknown>[]).map((r) => ({
        id: r.id, name: r.name, dir: r.dir, kind: r.kind, cmd: r.cmd, trigger: r.trigger ?? '',
        proc: projects.stateOf(String(r.id)),
        // 这个项目最近一次运行 —— 「重放上次」要用它当基线
        lastRun: store.lastRunIn(String(r.dir)),
      }));
      return json(res, rows);
    }

    // 探测：导入向导里选中目录后先给用户看一眼「我打算怎么启动它」
    if (route === '/api/projects/detect') {
      const dir = url.searchParams.get('dir') ?? '';
      return json(res, dir ? await projects.detect(dir) : { kind: 'unknown', cmd: '', note: '' });
    }

    if (route === '/api/projects/start' && req.method === 'POST') {
      const { id, replayFrom } = (await readJson(req)) as { id: string; replayFrom?: string };
      const row = store.getProject(id) as never as Record<string, unknown> | undefined;
      if (!row) return json(res, { error: '没有这个项目' }, 404);
      const p: projects.Project = {
        id: String(row.id), name: String(row.name), dir: String(row.dir),
        kind: String(row.kind), cmd: String(row.cmd),
        trigger: row.trigger ? String(row.trigger) : undefined,
        createdAt: Number(row.created_at),
      };
      const r = projects.start(
        p,
        {
          harnessPath: path.resolve(HERE, '../harness/register.ts'),
          pyHarnessPath: path.resolve(HERE, '../pyharness'),
          url: `http://127.0.0.1:${PORT}`,
          replayFrom: replayFrom ?? null,
        },
        (pid, entry) => broadcastRaw({ type: 'proc.log', id: pid, ...entry }),
        (pid, code) => broadcastRaw({ type: 'proc.exit', id: pid, code }),
      );
      broadcastRaw({ type: 'proc.state', id, state: projects.stateOf(id) });
      return json(res, r);
    }

    // 触发：服务型 agent 光启动不干活，得有人去戳它
    if (route === '/api/projects/trigger' && req.method === 'POST') {
      const { id } = (await readJson(req)) as { id: string };
      const row = store.getProject(id) as never as Record<string, unknown> | undefined;
      if (!row) return json(res, { error: '没有这个项目' }, 404);
      const r = projects.trigger(
        {
          id: String(row.id), name: String(row.name), dir: String(row.dir), kind: String(row.kind),
          cmd: String(row.cmd), trigger: row.trigger ? String(row.trigger) : undefined,
          createdAt: Number(row.created_at),
        },
        (pid, entry) => broadcastRaw({ type: 'proc.log', id: pid, ...entry }),
      );
      return json(res, r);
    }

    if (route === '/api/projects/stop' && req.method === 'POST') {
      const { id } = (await readJson(req)) as { id: string };
      return json(res, { ok: projects.stop(id) });
    }

    // ── 查询 API ──
    if (route === '/api/runs') {
      return json(res, store.listRuns(
        intParam('limit', 50, 5000),
        url.searchParams.get('groupId') ?? undefined,
      ));
    }
    if (route === '/api/groups') return json(res, store.listGroups());
    // 完整记录：把一次运行还原成对话（任务 → 回答 → 工具 → 下一轮），见 transcript.ts
    if (route === '/api/transcript') {
      const runId = url.searchParams.get('runId') ?? '';
      if (!runId) return json(res, { error: '需要 runId' }, 400);
      const calls = store.transcriptCalls(runId);
      return json(res, buildTranscript(calls, store.triggers([...new Set(calls.map((c) => c.run_id))])));
    }
    // 循环图：agent 和它的工具之间转了些什么（transcript.ts 的 buildLoopMap）
    if (route === '/api/loopmap') {
      const runId = url.searchParams.get('runId') ?? '';
      if (!runId) return json(res, { error: '需要 runId' }, 400);
      return json(res, buildLoopMap(buildTranscript(store.transcriptCalls(runId))));
    }
    // 时序：一轮一行的瀑布图，两轮之间的空档 = 工具执行时间（见 transcript.ts 的 buildTiming）
    if (route === '/api/timing') {
      const runId = url.searchParams.get('runId') ?? '';
      if (!runId) return json(res, { error: '需要 runId' }, 400);
      const calls = store.transcriptCalls(runId);
      if (!calls.length) return json(res, { rows: [], span: 0, modelMs: 0, toolMs: 0 });
      // 进程还在：最后一轮发起了工具、还没回到模型，就算「工具正在执行」。
      // 不看请求级运行有没有结束 —— dsh 这类服务收到一轮对话的请求就先回了，agent 在后台接着跑
      const run = store.getRun(runId) as { ended_at?: number | null; parent_run_id?: string | null; pid?: number | null } | undefined;
      const proc = run?.parent_run_id ? (store.getRun(run.parent_run_id) as typeof run) : run;
      const live = !!proc && proc.ended_at == null && proc.pid != null && pidAlive(proc.pid);
      return json(res, buildTiming(buildTranscript(calls), { live, now: Date.now() }));
    }
    // 历史：按「一次干活」列，带任务原文和结果，给人找「上次那一次」用（见 history.ts）
    if (route === '/api/history') {
      return json(res, buildHistory({
        ...store.historyRaw(),
        alive: pidAlive,
        now: Date.now(),
        q: url.searchParams.get('q') ?? undefined,
        limit: intParam('limit', 300, 2000),
      }));
    }
    if (route.startsWith('/api/runs/')) {
      const id = decodeURIComponent(route.slice('/api/runs/'.length));
      const run = store.getRun(id);
      return run ? json(res, { ...run, baseline: store.resolveBaseline(id) }) : json(res, { error: 'not found' }, 404);
    }
    if (route === '/api/calls') {
      return json(
        res,
        store.listCalls(
          url.searchParams.get('runId') ?? undefined,
          // 页面选中一次运行时按 runId 单独取，老运行的调用也拿得到；不带 runId 的全量列表才用 500 的缺省
          intParam('limit', 500, 20000),
          url.searchParams.get('node') ?? undefined,
        ),
      );
    }
    // ── 循环实时控制 ──
    // 覆写是**服务端持有、harness 每轮来取**：这样「改上限 / 跳出 / 再来一轮」
    // 在循环跑着的时候就能生效，不需要改代码也不需要重跑。
    if (route === '/api/loops') {
      if (req.method === 'POST') {
        const { loopId, ...ov } = (await readJson(req));
        loopOverrides.set(loopId, { ...(loopOverrides.get(loopId) ?? {}), ...ov });
        broadcastRaw({ type: 'loop.override', loopId, override: loopOverrides.get(loopId) });
        return json(res, { ok: true, override: loopOverrides.get(loopId) });
      }
      return json(res, {
        loops: [...loopSeen.values()],
        overrides: Object.fromEntries(loopOverrides),
      });
    }

    // 循环断点：和 LLM 闸门同构 —— 命中时这个响应悬着，被调试进程停在轮次边界上
    if (route === '/api/loop-gate' && req.method === 'POST') {
      const { runId: rid, loopId, iteration, armed } = (await readJson(req));
      loopSeen.set(loopId, { loopId, runId: rid, iteration, at: Date.now() });
      broadcastRaw({ type: 'loop.iteration', loopId, runId: rid, iteration });

      // 没开循环断点时立即返回，只把最新覆写捎回去 —— 这一步就是「实时改上限」的通道
      if (!armed) return json(res, { override: takeOverride(loopId) });

      broadcastRaw({ type: 'loop.paused', loopId, runId: rid, iteration });
      const decision = await new Promise<{ action?: string }>((resolve) => {
        loopWaiters.set(loopId, resolve);
        req.on('close', () => {
          loopWaiters.delete(loopId);
          resolve({});
        });
      });
      broadcastRaw({ type: 'loop.resumed', loopId, iteration });
      return json(res, { ...decision, override: takeOverride(loopId) });
    }

    if (route === '/api/loop-resume' && req.method === 'POST') {
      const { loopId, action, override } = (await readJson(req));
      if (override) loopOverrides.set(loopId, { ...(loopOverrides.get(loopId) ?? {}), ...override });
      const w = loopWaiters.get(loopId);
      if (w) {
        loopWaiters.delete(loopId);
        w({ action });
      }
      return json(res, { ok: !!w });
    }

    // ── 源码回写：可回写性分析 / 落盘 / 还原 ──
    if (route === '/api/writability') {
      const callId = url.searchParams.get('callId') ?? '';
      const field = url.searchParams.get('field') ?? 'system'; // system | message:<i>
      const c = store.getCall(callId) as any;
      if (!c) return json(res, { error: 'call not found' }, 404);

      let value = '';
      if (field === 'system') value = c.system ?? '';
      else if (field.startsWith('message:')) {
        const i = Number(field.slice(8));
        try {
          value = (JSON.parse(c.messages || '[]')[i]?.content as string) ?? '';
        } catch {
          value = '';
        }
      }
      let frames: { file: string; line?: number }[] = [];
      try {
        frames = JSON.parse(c.frames || '[]');
      } catch {
        /* ignore */
      }
      return json(res, { field, ...analyze(value, frames.map((f) => ({ file: f.file, line: f.line }))) });
    }

    if (route === '/api/source/apply' && req.method === 'POST') {
      const body = (await readJson(req));
      const bad = writableSource(body.file);
      if (bad) return json(res, { ok: false, error: bad }, 403);
      // 多段（模板的几个静态片段）走原子批量：要么全写要么不动，撤销用同一份备份
      const result = Array.isArray(body.edits) ? applyEdits(body) : applyEdit(body);
      if (result.ok) broadcastRaw({ type: 'source.changed', files: [body.file], by: 'platform' });
      return json(res, result);
    }

    if (route === '/api/source/revert' && req.method === 'POST') {
      const { file, backup } = (await readJson(req));
      const bad = writableSource(file) ?? backupOf(file, backup);
      if (bad) return json(res, { ok: false, error: bad }, 403);
      const result = revert(file, backup);
      if (result.ok) broadcastRaw({ type: 'source.changed', files: [file], by: 'platform' });
      return json(res, result);
    }

    // ── 重放缓存查询（harness 调用）──
    if (route === '/api/replay') {
      const hit = replayFor(
        url.searchParams.get('baseline') ?? '',
        url.searchParams.get('hash') ?? '',
        url.searchParams.get('run'),
      );
      return hit ? json(res, { hit: true, ...hit }) : json(res, { hit: false });
    }

    if (route === '/api/compare') {
      const b = url.searchParams.get('b') ?? '';
      // 不给 a 就用 B 的重放基线 —— 「改完重跑，和上一版比」是最常见的问法
      const a = url.searchParams.get('a') || (b ? store.resolveBaseline(b) : null) || '';
      if (!b) return json(res, { error: '需要 b（改动后的运行）' }, 400);
      if (!a) return json(res, { error: `运行 ${b} 不是重放出来的，没有缺省基线；请指定 a` }, 400);
      return json(res, compareRuns(a, b, store.llmCallsFor(a), store.llmCallsFor(b), {
        failingA: store.failingByCall(a),
        failingB: store.failingByCall(b),
        summaryA: store.scoreSummary(a),
        summaryB: store.scoreSummary(b),
      }));
    }

    // ── 评分 ──
    // 规则判定由服务端自己写（source=rule），这里只接 AI 和人的判定
    if (route === '/api/scores') {
      if (req.method === 'POST') {
        const body = (await readJson(req));
        const source = body.source === 'human' ? 'human' : 'ai';
        const r = store.upsertScore({ ...body, source });
        if ('error' in r) return json(res, r, 400);
        broadcastScores(r.run_id, r.call_id);
        return json(res, r);
      }
      return json(res, store.scores({
        runId: url.searchParams.get('runId') ?? undefined,
        callId: url.searchParams.get('callId') ?? undefined,
      }));
    }
    if (route === '/api/scores/delete' && req.method === 'POST') {
      const { scoreId } = (await readJson(req));
      const row = store.getScore(String(scoreId ?? ''));
      const ok = store.deleteScore(String(scoreId ?? ''));
      if (ok && row) broadcastScores(row.run_id, row.call_id);
      return json(res, { ok });
    }

    if (route === '/api/search') {
      return json(
        res,
        store.searchCalls(
          url.searchParams.get('q') ?? '',
          url.searchParams.get('runId') ?? undefined,
          intParam('limit', 20, 500),
        ),
      );
    }
    if (route === '/api/failures') {
      return json(res, store.failures(url.searchParams.get('runId') ?? undefined));
    }
    // Agent 语义流程图（画布用）—— 步骤/循环/分支，而不是函数调用图
    // ── 规格（意图图）与对账 ──
    if (route === '/api/spec') {
      const name = url.searchParams.get('name') || 'agent';
      if (req.method === 'POST') {
        const spec = (await readJson(req)) as Spec;
        spec.name = spec.name || name;
        spec.updatedAt = Date.now();
        store.putSpec(spec.name, spec);
        broadcastRaw({ type: 'spec.updated', name: spec.name });
        return json(res, spec);
      }
      if (req.method === 'DELETE') {
        store.deleteSpec(name);
        broadcastRaw({ type: 'spec.updated', name });
        return json(res, { ok: true });
      }
      return json(res, store.getSpec(name) ?? emptySpec(name));
    }

    if (route === '/api/specs') return json(res, store.listSpecs());

    // 从一次实际运行反推规格草稿 —— 从零画图门槛太高，先跑一次再改
    if (route === '/api/spec/from-run' && req.method === 'POST') {
      const { runId, name = 'agent' } = (await readJson(req)) as {
        runId?: string;
        name?: string;
      };
      const rid = runId || store.latestRunId();
      if (!rid) return json(res, { error: '还没有任何运行' }, 400);
      const spec = specFromFlow(flowFor(rid), name);
      store.putSpec(name, spec);
      broadcastRaw({ type: 'spec.updated', name });
      return json(res, spec);
    }

    if (route === '/api/spec/diff') {
      const name = url.searchParams.get('name') || 'agent';
      const rid = url.searchParams.get('runId') || store.latestRunId();
      const spec = (store.getSpec(name) ?? emptySpec(name)) as Spec;
      const flow = rid ? flowFor(rid) : buildFlow([], [], null);
      return json(res, { spec, flow, ...reconcile(spec, flow) });
    }

    if (route === '/api/flow') {
      const rid = url.searchParams.get('runId') || store.latestRunId();
      return json(res, rid ? flowWithAnomalies(rid) : { ...buildFlow([], [], null), anomalies: [] });
    }
    if (route === '/api/graph') {
      return json(res, buildGraph(store.callPaths(url.searchParams.get('runId') ?? undefined)));
    }
    // ── 追查：prompt 按来源拆开 ──
    if (route.startsWith('/api/calls/') && route.endsWith('/anatomy')) {
      const id = decodeURIComponent(route.slice('/api/calls/'.length, -'/anatomy'.length));
      const c = store.getCall(id) as never as { kind: string; run_id: string } | undefined;
      if (!c) return json(res, { error: 'not found' }, 404);
      if (c.kind !== 'llm') return json(res, { error: '只有模型调用有 prompt' }, 400);
      const runCalls = store.callsOfRun(c.run_id) as never[];
      const me = runCalls.find((x: { call_id: string }) => x.call_id === id);
      return json(res, anatomize(me as never, runCalls as never));
    }
    // ── 验证：两次运行按步骤对齐 ──
    if (route === '/api/verify') {
      const b = url.searchParams.get('b') ?? '';
      const a = url.searchParams.get('a') || (b ? store.resolveBaseline(b) : null) || '';
      if (!b) return json(res, { error: '需要 b（改动后的运行）' }, 400);
      if (!a) return json(res, { error: `运行 ${b} 不是重放出来的，没有缺省基线；请指定 a` }, 400);
      return json(res, verifyFor(a, b));
    }
    // ── 验证：同一步前后两次调用的 prompt / 输出差异 ──
    if (route === '/api/verify/diff') {
      const ca = store.getCall(url.searchParams.get('a') ?? '') as never as Record<string, string> | undefined;
      const cb = store.getCall(url.searchParams.get('b') ?? '') as never as Record<string, string> | undefined;
      if (!ca || !cb) return json(res, { error: '需要两次调用 a 和 b' }, 400);
      return json(res, {
        a: ca.call_id,
        b: cb.call_id,
        prompt: diffLines(promptLines(ca), promptLines(cb)),
        output: diffLines(outputLines(ca), outputLines(cb)),
      });
    }
    // ── 验证：拿历史请求批量回归 ──
    if (route === '/api/regress' && req.method === 'POST') {
      const body = (await readJson(req)) ?? {};
      if (!body.baseline) return json(res, { error: '需要 baseline（出过问题的那个进程 / 运行组）' }, 400);
      const r = startRegression(regressDeps, body);
      return json(res, r, 'error' in r ? 400 : 200);
    }
    if (route === '/api/regress') return json(res, listBatches(url.searchParams.get('baseline') ?? undefined));
    if (route.startsWith('/api/regress/')) {
      const b = getBatch(decodeURIComponent(route.slice('/api/regress/'.length)));
      return b ? json(res, b) : json(res, { error: 'not found' }, 404);
    }

    // ── 追查：同一步，跨请求看规律 ──
    if (route === '/api/steps/compare') {
      const rid = url.searchParams.get('runId') || store.latestRunId();
      const stepId = url.searchParams.get('stepId') ?? '';
      if (!rid || !stepId) return json(res, { error: '需要 runId 和 stepId' }, 400);
      const flow = flowFor(rid);
      const runIds = [...new Set(flow.steps.flatMap((s) => s.spans.map((x) => x.runId)).filter(Boolean) as string[])];
      const r = stepCompare(flow, stepId, store.triggers(runIds));
      return r ? json(res, r) : json(res, { error: `这次运行里没有步骤 ${stepId}` }, 404);
    }

    if (route.startsWith('/api/calls/')) {
      const row = store.getCall(decodeURIComponent(route.slice('/api/calls/'.length)));
      return row ? json(res, row) : json(res, { error: 'not found' }, 404);
    }
    if (route === '/api/health') {
      return json(res, {
        ok: true,
        db: DB_FILE,
        subscribers: subscribers.size,
        // 页面用它渲染「怎么接入」的命令，避免用户自己拼绝对路径
        harnessPath: path.resolve(HERE, '../harness/register.ts'),
        pyHarnessPath: path.resolve(HERE, '../pyharness'),
        proxyBase: `http://127.0.0.1:${PORT}/p`,
        proxyHelp: proxyHelp(PORT),
        langfuse: langfuseTracer.enabled,
      });
    }

    // ── 静态页面 ──
    const file = route === '/' ? 'index.html' : route.replace(/^\/+/, '');
    const abs = path.resolve(WEB_DIR, file);
    if (!abs.startsWith(WEB_DIR)) return json(res, { error: 'forbidden' }, 403); // 防目录穿越
    const data = await readFile(abs).catch(() => null);
    if (!data) return json(res, { error: 'not found' }, 404);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] ?? 'application/octet-stream' });
    return res.end(data);
  } catch (err) {
    // 请求本身有问题（坏 JSON、太大）是 4xx，不是服务出错
    if (err instanceof BadRequest) return json(res, { error: err.message }, 400);
    if (err instanceof Error && err.message === 'payload too large') return json(res, { error: err.message }, 413);
    return json(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// 我们启动的项目进程是自成进程组的 —— 调试器自己退出时必须把它们带走，
// 否则用户关掉调试器，被调试的服务还在后台占着端口。
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    projects.stopAll();
    // 退出前把积压的 Langfuse span 发出去（批量导出是异步的，直接 exit 会丢尾部数据）
    void langfuseTracer.shutdown().finally(() => process.exit(0));
  });
}
process.on('exit', () => projects.stopAll());

server.listen(PORT, '127.0.0.1', () => {
  console.log(`agentmake  →  http://127.0.0.1:${PORT}`);
  console.log(`db         →  ${DB_FILE}`);
  console.log('\n浏览器打开上面的地址 → 「+ 导入项目」→ 选中工程目录 → 点 ▶ 就能跑。');
  console.log('要自己在终端里接入，运行  agentmake attach  看命令。\n');
});
