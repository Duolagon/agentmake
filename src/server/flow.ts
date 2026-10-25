// Agent 语义流程图。
//
// 和 graph.ts 的区别：graph.ts 画的是**函数调用图**（谁调用了谁），那是技术视角；
// 这里画的是 **agent 做了什么** —— 步骤、循环轮次、分支、并发、每步的输入输出。
//
//   函数调用图：   refine → callModel ×10
//   agent 流程图： [循环 refine · 已跑 5/5 轮] → 每轮 [LLM 评审 「第 N 轮评审」→「明白了」]
//
// 后者才是用户想看的。核心推导：
//   步骤   = 调用点（caller#fn:line）—— 同一行代码发出的调用是同一个步骤，跑多少轮都是它
//   轮次   = 循环插桩上报的 loop.iteration，按 seq 与调用交错还原「这次调用属于第几轮」
//   分支   = 在循环里但没有每轮都出现的步骤，说明它在 if 里
//   并发   = 时间区间重叠的调用（Promise.all / mapLimit），画成同一排 + 瀑布

import { messageFullText, toolCallText } from '../shared/tooltext.ts';
import type { Frame, MessageIR, ToolCallIR } from '../shared/types.ts';
import { isDropped, measure, outputOf, type Measure } from './dataflow.ts';

export type Span = {
  callId: string;
  runId: string | null;
  t: number;
  ms: number;
  ok: boolean;
  iteration: number | null;
  /** 还没收到响应 —— 正在跑，或停在断点上 */
  pending: boolean;
  /** 这次调用交给下游的数据量 */
  outBytes: number;
  /** 模型调用的输入 token —— 循环里逐轮画出来，prompt 越滚越大一眼就看得见 */
  inTok: number | null;
  /** 被判定失败的规则 / 评分名（flowFor 里补上） */
  failing: string[];
  /** 这次调用的产出摘要（回答 / 工具调用 / HTTP 状态），对比表上一行一个 */
  out: string;
  /** 这次调用之后，同一次运行里下一步走到了哪 —— 分支选错了在这一列上最显眼 */
  next: string | null;
  /** 响应来自重放缓存（没真打模型） */
  replayed: boolean;
  /** 请求指纹 —— 两次运行对齐时，指纹变了就是「这一步的输入变了」 */
  hash: string | null;
  /** 喂给这次调用的上游数据（只有下游是模型调用、且测得到时才有） */
  input: { from: string; items: number | null; used: number | null; coverage: number | null; bytes: number; dropped: boolean; missing: string[] } | null;
};

/**
 * 一条连线上真实流过的数据。
 *
 * last 是最近一次的测量（画在线上）；dropped 是「数据在进下游前被丢掉」发生了几次，
 * 对应 samples 次里的几次 —— 「41 次里 41 次」和「41 次里 1 次」是完全不同的 bug。
 */
export type EdgeData = {
  samples: number;
  dropped: number;
  last: Measure;
  /** 发生过丢失的请求级运行（最多记 50 个），异常栏要报「影响了哪些请求」 */
  droppedRuns: string[];
  /** 一次丢失发生时的下游调用，点异常就跳过去看那次的 prompt */
  exampleCallId: string | null;
  /** 最近一次的下游还在跑：上游给了多少已经知道，用了多少还不知道 */
  waiting: boolean;
};

export type FlowEdge = { from: string; to: string; count: number; back: boolean; data: EdgeData | null };

export type FlowStep = {
  id: string;
  /** 语义类型：模型调用 / 工具调用 */
  kind: 'llm' | 'tool';
  label: string;
  file: string;
  line: number;
  /** 所属循环（若在循环体内） */
  loopId: string | null;
  order: number;
  /** 同一排 = 并发执行 */
  row: number;
  calls: number;
  errors: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  model: string | null;
  provider: string | null;
  /** 最近一次的输入/输出摘要，直接画在节点上 —— 不该为了看一眼内容再点一次 */
  preview: { in: string; out: string } | null;
  /** 这一步在哪些轮里出现过 */
  iterations: number[];
  /** 在循环里但没有每轮都跑 —— 说明它在分支里 */
  conditional: boolean;
  /** 最大并发度（同时在飞的调用数） */
  concurrency: number;
  /** harness = 有调用栈，能定位到源码行；proxy = 代理接入，只有请求本身 */
  source: 'harness' | 'proxy';
  spans: Span[];
  callIds: string[];
  /** 正在跑的调用数，以及其中最早那次的开始时刻 —— 页面据此画「正在跑 · 已 2.1s」 */
  running: number;
  runningSince: number | null;
  /** 判定失败按名字计数：{ 'rule.truncated': 3 }（flowFor 里补上） */
  failing: Record<string, number>;
};

export type FlowLoop = {
  id: string;
  label: string;
  file: string;
  line: number;
  /** 已经跑完的轮数 */
  iterations: number;
  /** 运行时改过的上限（没改过为 null） */
  maxOverride: number | null;
  /** condition | break | max_override | null(还在跑) */
  exitReason: string | null;
  /** 循环体的结束行。判断「这次调用在不在循环里」要的是区间，不是一个起点 */
  endLine: number;
  /** 还没退出 —— 页面可以对它做实时控制 */
  running: boolean;
  /** 最后一次听到这个循环的动静。用来判断它是不是其实早就不转了 */
  lastSeen: number;
  stepIds: string[];
};

export type Flow = {
  runId: string | null;
  steps: FlowStep[];
  loops: FlowLoop[];
  /** 步骤之间的先后关系（按实际执行顺序，去重），连同线上流过的数据 */
  edges: FlowEdge[];
  totals: { llm: number; tool: number; ms: number; inputTokens: number; outputTokens: number; errors: number };
  window: { t0: number; t1: number };
};

export type CallRow = {
  call_id: string;
  run_id?: string | null;
  seq: number;
  kind: string;
  provider: string | null;
  model: string | null;
  url: string | null;
  method: string | null;
  frames: string | null;
  system: string | null;
  messages: string | null;
  response_text: string | null;
  response_tool_calls?: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  ok: number | null;
  error: string | null;
  started_at: number;
  request_hash?: string | null;
  replayed?: number | null;
  response_body?: string | null;
  response_bytes?: number | null;
  body_truncated?: number | null;
  status?: number | null;
};

export type LoopEvent = {
  type: string;
  seq: number;
  loopId: string;
  runId?: string | null;
  iteration?: number | null;
  iterations?: number | null;
  reason?: string | null;
  ts?: number | null;
  endLine?: number | null;
  maxOverride?: number | null;
};

const parse = (s: unknown, d: unknown) => {
  try {
    return JSON.parse(String(s));
  } catch {
    return d;
  }
};

const clip = (s: unknown, n = 140) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
};

/**
 * 步骤身份 = 调用点。
 *
 * 最内层的用户帧是真正发 fetch 的地方，但它几乎总是通用封装
 * （callModel / httpGet / fetchWithTimeout）—— 全项目的调用会挤成一个节点。
 * 用**调用它的那一层 + 行号**当身份，才对得上语义步骤（评审 / 修订 / 抓取）。
 */
type StepId = { id: string; label: string; file: string; line: number; source: 'harness' | 'proxy' };

export function stepIdOf(frames: Frame[], c: CallRow, wrappers?: Set<string>): StepId {
  if (!frames.length) return framelessStepId(c);
  const inner = frames[frames.length - 1];
  // 最内层不是通用封装（loadHistory 自己就调了 fetch）—— 它本身就是语义步骤
  if (wrappers && frames.length >= 2 && !wrappers.has(`${inner.file}#${inner.fn}`) && inner.fn !== '<top>') {
    return { id: `${inner.file}#${inner.fn}:${inner.line}`, label: inner.fn, file: inner.file, line: inner.line, source: 'harness' };
  }
  const caller = frames.length >= 2 ? frames[frames.length - 2] : inner;
  return {
    id: `${caller.file}#${caller.fn}:${caller.line}`,
    label: caller.fn === '<top>' ? (caller.file.split('/').pop() ?? caller.fn) : caller.fn,
    file: caller.file,
    line: caller.line,
    source: 'harness',
  };
}

/** 名字一看就是通用封装的：callModel / chat / fetchWithTimeout / httpGet / request … */
// 驼峰和蛇形都认：callModel / call_model、withRetry / with_retry
const WRAPPER_NAME =
  /^(request|call|chat|complete|completion|invoke|post|get|send|retry)$|^chat|fetch|http|llm|complet|call_?(model|api|openai|gpt|claude|gemini|deepseek)|with_?retry|with_?timeout/i;

/**
 * 哪些最内层函数是「通用封装」—— 它们自己不是步骤，调用它们的那一层才是。
 *
 * 判据二选一：被两个以上不同的调用点调用（chat 被 analyze / polish / reply 共用），
 * 或者名字就是封装的样子。都不是的（loadHistory 自己发 fetch）就是语义步骤本身 ——
 * 早期一律取上一层，于是 loadHistory 在图上被叫成了 `Server.<anonymous>`。
 */
export function wrapperSet(calls: CallRow[]): Set<string> {
  const callers = new Map<string, Set<string>>();
  for (const c of calls) {
    const f = parse(c.frames, []) as Frame[];
    if (f.length < 2) continue;
    const inner = f[f.length - 1];
    const caller = f[f.length - 2];
    const k = `${inner.file}#${inner.fn}`;
    const set = callers.get(k) ?? new Set<string>();
    set.add(`${caller.file}#${caller.fn}:${caller.line}`);
    callers.set(k, set);
  }
  const out = new Set<string>();
  for (const [k, set] of callers) {
    const fn = k.slice(k.lastIndexOf('#') + 1);
    if (set.size >= 2 || WRAPPER_NAME.test(fn)) out.add(k);
  }
  return out;
}

/**
 * 代理接入的调用没有调用栈 —— 换个身份依据。
 *
 * 实践里，一个 agent 的每个语义步骤几乎总有各自的 system prompt（「你是审稿人」/
 * 「你是改写助手」），所以 (模型 + system 指纹) 是最接近「哪一步」的可得信号。
 * 拿不到 system 时退回模型名，再退回 URL 路径 —— 一定要给出一个节点，
 * 不能因为没有调用栈就在流程图上凭空消失。
 */
function framelessStepId(c: CallRow): StepId {
  if (c.kind !== 'llm') {
    const p = pathOf(c.url);
    return { id: `http:${c.method ?? 'GET'} ${p}`, label: `${c.method ?? 'GET'} ${p}`, file: '', line: 0, source: 'proxy' };
  }
  const sys = (c.system ?? '').trim();
  const model = c.model ?? 'llm';
  const label = sys ? firstLine(sys) : model;
  return { id: `llm:${model}:${fingerprint(sys)}`, label, file: '', line: 0, source: 'proxy' };
}

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim()) ?? s;
  return l.trim().slice(0, 32);
}

function pathOf(url: string | null): string {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url ?? '');
  }
}

/** djb2 —— 只要求稳定和短，不做密码学用途 */
function fingerprint(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function splitLoopId(id: string): [string, number] {
  const i = id.lastIndexOf(':');
  return [id.slice(0, i), Number(id.slice(i + 1)) || 0];
}

/**
 * 调用栈里有帧落在循环体的**行号区间**内 —— 说明这次调用发生在循环体内。
 *
 * 早期版本只比「行号 ≥ 循环起始行」。在真实项目上这个近似当场崩掉：news 的
 * server.mjs:53 有个读请求体的 `for await`，而请求处理函数在同一文件更靠后的
 * 位置，于是这条流水线上**每一次**调用都被算进那个循环，画布上出现
 * 「循环 server.mjs:53 正在跑，抓取×3 在第 1 轮」这种纯属虚构的结构。
 *
 * 多个循环都命中时取最内层（起始行最大的那个）。
 */
function findEnclosingLoop(frames: Frame[], loops: Map<string, FlowLoop>): string | null {
  let best: FlowLoop | null = null;
  for (const l of loops.values()) {
    // endLine 缺失只发生在旧库里的历史数据上（那时的 harness 还不上报结束行）。
    // 对这些数据退回旧的宽松判据 —— 不准，但总比让历史运行的循环整个消失强。
    const hit = l.endLine
      ? frames.some((f) => f.file === l.file && f.line >= l.line && f.line <= l.endLine)
      : frames.some((f) => f.file === l.file && f.line >= l.line);
    if (hit && (!best || l.line > best.line)) best = l;
  }
  return best ? best.id : null;
}

export function buildFlow(calls: CallRow[], loopEvents: LoopEvent[], runId: string | null = null): Flow {
  // ── 1. 循环骨架 ──
  const loops = new Map<string, FlowLoop>();
  for (const e of loopEvents) {
    if (!e.loopId) continue;
    let l = loops.get(e.loopId);
    if (!l) {
      const [file, line] = splitLoopId(e.loopId);
      l = {
        id: e.loopId,
        label: `循环 @ ${file.split('/').pop()}:${line}`,
        file,
        line,
        iterations: 0,
        maxOverride: null,
        exitReason: null,
        endLine: 0,
        running: true,
        lastSeen: 0,
        stepIds: [],
      };
      loops.set(e.loopId, l);
    }
    const n = e.iteration ?? e.iterations ?? 0;
    if (n) l.iterations = Math.max(l.iterations, n);
    if (e.endLine) l.endLine = Math.max(l.endLine, e.endLine);
    if (e.ts) l.lastSeen = Math.max(l.lastSeen, e.ts);
    if (e.maxOverride != null) l.maxOverride = e.maxOverride;
    if (e.type === 'loop.exited') {
      l.exitReason = e.reason ?? 'condition';
      l.running = false;
    }
  }

  // ── 2. 把「第几轮」还原到每次调用上 ──
  // loop.iteration 事件和 llm.before 共用同一个 seq 计数器，按 seq 交错回放即可。
  const iterAt = new Map<string, number>(); // callSeq 之前最后一次看到的轮次
  const cursor = new Map<string, number>();
  const timeline = [
    ...loopEvents.map((e) => ({ seq: e.seq, loop: e })),
    ...calls.map((c) => ({ seq: c.seq, call: c })),
  ].sort((a, b) => a.seq - b.seq);

  for (const item of timeline) {
    if ('loop' in item && item.loop) {
      const e = item.loop;
      if (e.type === 'loop.iteration' && e.iteration) cursor.set(e.loopId, e.iteration);
    } else if ('call' in item && item.call) {
      for (const [lid, n] of cursor) iterAt.set(`${item.call.call_id}|${lid}`, n);
    }
  }

  // ── 3. 步骤聚合 ──
  const steps = new Map<string, FlowStep>();
  const edges = new Map<string, FlowEdge>();
  const totals = { llm: 0, tool: 0, ms: 0, inputTokens: 0, outputTokens: 0, errors: 0 };
  // 先后关系按运行分开算：一个进程同时处理的几个请求，调用在时间上是交错的，
  // 混在一起排序会连出「请求 A 的抓取 → 请求 B 的分析」这种不存在的边
  const prevOf = new Map<string, string>();
  const seqOf = new Map<string, { step: string; call: CallRow }[]>();
  const lastSpanOf = new Map<string, Span>();
  let order = 0;
  const wrappers = wrapperSet(calls);
  let t0 = Infinity;
  let t1 = 0;

  for (const c of calls) {
    const frames = parse(c.frames, []) as Frame[];
    const sid = stepIdOf(frames, c, wrappers);

    const isLLM = c.kind === 'llm';
    const failed = c.ok === 0 || !!c.error;
    const pending = c.duration_ms == null && c.ok == null && !c.error;
    const rid = c.run_id ?? '';
    totals[isLLM ? 'llm' : 'tool']++;
    totals.ms += c.duration_ms ?? 0;
    totals.inputTokens += c.input_tokens ?? 0;
    totals.outputTokens += c.output_tokens ?? 0;
    if (failed) totals.errors++;

    const loopId = findEnclosingLoop(frames, loops);
    const iteration = loopId ? (iterAt.get(`${c.call_id}|${loopId}`) ?? null) : null;

    let s = steps.get(sid.id);
    if (!s) {
      s = {
        ...sid,
        kind: isLLM ? 'llm' : 'tool',
        loopId,
        order: order++,
        row: 0,
        calls: 0,
        errors: 0,
        ms: 0,
        inputTokens: 0,
        outputTokens: 0,
        model: c.model,
        provider: c.provider,
        preview: null,
        iterations: [],
        conditional: false,
        concurrency: 1,
        spans: [],
        callIds: [],
        running: 0,
        runningSince: null,
        failing: {},
      };
      steps.set(sid.id, s);
      if (loopId) loops.get(loopId)!.stepIds.push(sid.id);
    }

    s.calls++;
    s.ms += c.duration_ms ?? 0;
    s.inputTokens += c.input_tokens ?? 0;
    s.outputTokens += c.output_tokens ?? 0;
    if (failed) s.errors++;
    s.callIds.push(c.call_id);
    s.model ??= c.model;
    s.provider ??= c.provider;
    if (iteration && !s.iterations.includes(iteration)) s.iterations.push(iteration);

    const t = c.started_at ?? 0;
    const ms = c.duration_ms ?? 0;
    const outBytes = pending ? 0 : outputOf(c).bytes;
    const outText = isLLM
      ? [c.response_text, ...((parse(c.response_tool_calls, []) ?? []) as ToolCallIR[]).map((x) => `→ ${toolCallText(x)}`)]
          .filter(Boolean).join(' ')
      : `HTTP ${c.ok ? 'OK' : 'ERR'}${c.response_bytes != null ? ` · ${c.response_bytes}B` : ''}`;
    const span: Span = {
      callId: c.call_id, runId: c.run_id ?? null, t, ms, ok: !failed, iteration, pending, outBytes,
      inTok: c.input_tokens ?? null, failing: [],
      out: clip(c.error ? `❌ ${c.error}` : outText, 80), next: null, input: null,
      replayed: !!c.replayed, hash: c.request_hash ?? null,
    };
    s.spans.push(span);
    // 同一次运行里上一次调用的「下一步」就是这一步
    const prevSpan = lastSpanOf.get(rid);
    if (prevSpan) prevSpan.next = sid.label;
    lastSpanOf.set(rid, span);
    if (pending) {
      s.running++;
      s.runningSince = s.runningSince == null ? t : Math.min(s.runningSince, t);
    }
    if (t) {
      t0 = Math.min(t0, t);
      t1 = Math.max(t1, t + ms);
    }

    // 节点上直接显示最近一次的输入输出
    const msgs = (parse(c.messages, []) ?? []) as MessageIR[];
    // 只调工具的回答没有正文 —— 这时「输出」就是它选的工具
    const calls = ((parse(c.response_tool_calls, []) ?? []) as ToolCallIR[]).map((x) => `→ ${toolCallText(x)}`);
    const last = msgs.at(-1);
    s.preview = isLLM
      ? {
          in: clip((last ? messageFullText(last) : '') || c.system || ''),
          out: clip(c.error ? `❌ ${c.error}` : [c.response_text, ...calls].filter(Boolean).join('\n')),
        }
      : {
          in: clip(`${c.method ?? 'GET'} ${c.url ?? ''}`),
          out: clip(c.error ? `❌ ${c.error}` : `HTTP ${failed ? 'ERR' : 'OK'}`),
        };

    const prev = prevOf.get(rid);
    const history = seqOf.get(rid) ?? [];
    if (prev && prev !== sid.id) {
      const k = `${prev}→${sid.id}`;
      let e = edges.get(k);
      if (e) e.count++;
      else {
        // 回边：目标步骤在源步骤之前出现过 —— 这就是「又转了一圈」
        const back = (steps.get(sid.id)?.order ?? 0) < (steps.get(prev)?.order ?? 0);
        e = { from: prev, to: sid.id, count: 1, back, data: null };
        edges.set(k, e);
      }
      // 喂给这次调用的，是紧挨在它前面、同一个上游步骤的那一批调用（并发抓的 7 个信源算一批）
      const batch: CallRow[] = [];
      for (let i = history.length - 1; i >= 0 && history[i].step === prev; i--) batch.unshift(history[i].call);
      const done = batch.filter((b) => b.duration_ms != null);
      if (done.length) {
        if (pending) {
          // 下游还在跑：先把上游给了多少画上去，「用了多少」等它回来再算
          const m = measure(done, { kind: 'pending' });
          if (e.data) { e.data.last = m; e.data.waiting = true; }
          else e.data = { samples: 0, dropped: 0, last: m, droppedRuns: [], exampleCallId: null, waiting: true };
        } else {
          // 只有在下游开始之前就跑完的上游才可能喂给它 —— 并发的两次调用只是时间上挨着
          // （dsh 一边跑主 agent、一边起会话标题），拿它们对账只会得出「数据全丢了」的误报。
          // 留 1 秒余量：探针在后台读流式回答的副本，记下的结束时间会比 agent 实际拿到回答晚一点
          const fed = done.filter((b) => b.started_at == null || c.started_at == null || b.started_at + (b.duration_ms ?? 0) <= c.started_at + 1000);
          const m = fed.length ? measure(fed, c) : null;
          // 一个字都没用上，但下游的数据明显来自更早的另一次调用（主 agent 接着自己上一轮往下走）：
          // 紧挨着的那一步只是旁路，不是它的数据来源，不算「丢了」。
          // 真丢了的（规划的结果没进执行的 prompt），下游哪儿也找不到来源，照报
          if (m && !(m.coverage === 0 && m.items == null && fedByEarlier(history.slice(0, history.length - batch.length), c))) {
            noteData(e, m, rid, c.call_id);
            if (m.used != null || m.coverage != null) {
              span.input = {
                from: prev, items: m.items, used: m.used, coverage: m.coverage, bytes: m.bytes,
                dropped: isDropped(m), missing: m.missing ?? [],
              };
            }
          }
        }
      }
    }
    prevOf.set(rid, sid.id);
    history.push({ step: sid.id, call: c });
    seqOf.set(rid, history);
  }

  // ── 4. 分支 / 并发 ──
  for (const s of steps.values()) {
    const l = s.loopId ? loops.get(s.loopId) : null;
    // 在循环里却没有每轮都跑 —— 它在 if 分支里。这是「哪条路没走」的直接证据。
    //
    // 只看**已经跑完**的轮：循环还在跑时，最后一轮才刚进来、这一步还没轮到，
    // 早期版本把它算成「缺席」，于是每个循环步骤一开跑就被误标成分支。
    // 最后一轮不算数的两种情况：循环还在跑（这一步还没轮到），
    // 以及在轮次边界上被跳出（这一轮刚进来就停了）。
    const partial = !!l && (l.running || l.exitReason === 'break_boundary');
    const done = l ? l.iterations - (partial ? 1 : 0) : 0;
    s.conditional = !!l && done > 1 && s.iterations.filter((i) => i <= done).length < done;
    s.concurrency = maxOverlap(s.spans);
  }
  assignRows([...steps.values()]);

  return {
    runId,
    steps: [...steps.values()].sort((a, b) => a.order - b.order),
    loops: [...loops.values()],
    edges: [...edges.values()],
    totals,
    window: { t0: Number.isFinite(t0) ? t0 : 0, t1 },
  };
}

function noteData(e: FlowEdge, m: Measure, runId: string, callId: string): void {
  const d = (e.data ??= { samples: 0, dropped: 0, last: m, droppedRuns: [], exampleCallId: null, waiting: false });
  d.samples++;
  d.last = m;
  d.waiting = false;
  if (isDropped(m)) {
    d.dropped++;
    d.exampleCallId = callId;
    if (runId && !d.droppedRuns.includes(runId) && d.droppedRuns.length < 50) d.droppedRuns.push(runId);
  }
}

function med(xs: number[]): number {
  const v = [...xs].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** 同时在飞的调用数 —— Promise.all / mapLimit 的并发度 */
function maxOverlap(spans: Span[]): number {
  if (spans.length < 2) return spans.length;
  const pts = spans.flatMap((s) => [
    { t: s.t, d: 1 },
    { t: s.t + Math.max(s.ms, 1), d: -1 },
  ]);
  pts.sort((a, b) => a.t - b.t || a.d - b.d);
  let cur = 0;
  let max = 0;
  for (const p of pts) {
    cur += p.d;
    max = Math.max(max, cur);
  }
  return max;
}

/**
 * 排（row）：时间区间重叠的步骤并排画，否则往下排。
 *
 * 这样 Promise.all 分出去的三条支路是横着的一排，而顺序执行的步骤是竖着一列 ——
 * 一眼就能看出哪里在并发。
 */
function assignRows(steps: FlowStep[]): void {
  // 时间按「各自运行的起点」对齐后再取中位数：常驻服务的几个请求是交错执行的，
  // 直接拿绝对时间比，请求 A 的 analyze（在断点上停了两分钟）会和请求 B 的 loadHistory 重叠，
  // 被画成「这 2 步同时进行」。对齐之后图反映的是**一个请求内部**的典型结构。
  const runStart = new Map<string, number>();
  for (const s of steps) {
    for (const x of s.spans) {
      const k = x.runId ?? '';
      runStart.set(k, Math.min(runStart.get(k) ?? Infinity, x.t));
    }
  }
  const bounds = steps.map((s) => {
    const per = new Map<string, { lo: number; hi: number }>();
    for (const x of s.spans) {
      const k = x.runId ?? '';
      const t = x.t - (runStart.get(k) ?? 0);
      const b = per.get(k) ?? { lo: Infinity, hi: -Infinity };
      b.lo = Math.min(b.lo, t);
      b.hi = Math.max(b.hi, t + Math.max(x.ms, 1));
      per.set(k, b);
    }
    const vals = [...per.values()];
    return { s, lo: med(vals.map((v) => v.lo)), hi: med(vals.map((v) => v.hi)) };
  });
  bounds.sort((a, b) => a.lo - b.lo || a.s.order - b.s.order);

  let row = 0;
  let rowHi = -Infinity;
  let rowLoop: string | null | undefined;
  for (const b of bounds) {
    // 要求**实质**重叠：时间戳只有毫秒精度，紧挨着执行的两步（前一步刚结束、
    // 后一步立刻开始）会算出 0~1ms 的假重叠，被误画成并发。
    const overlap = Math.min(b.hi, rowHi) - b.lo;
    const meaningful = overlap >= Math.max(2, 0.5 * (b.hi - b.lo));
    if (!meaningful || b.s.loopId !== rowLoop) {
      row++;
      rowHi = b.hi;
      rowLoop = b.s.loopId;
    } else {
      rowHi = Math.max(rowHi, b.hi);
    }
    b.s.row = row;
  }
}

/** 下游的 prompt 是不是主要由更早的某次调用喂的（只看最近 20 次，够覆盖一轮 agent 循环） */
function fedByEarlier(earlier: { call: CallRow }[], consumer: CallRow): boolean {
  for (const { call } of earlier.slice(-20).reverse()) {
    if (call.duration_ms == null) continue;
    const m = measure([call], consumer);
    if (m.coverage != null && m.coverage >= 0.5) return true;
  }
  return false;
}
