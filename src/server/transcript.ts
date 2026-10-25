// 完整记录：把一次运行还原成「对话」—— 任务 → 模型回答 → 它调了哪些工具、拿到什么 → 下一轮 ……
//
// 原料是一次次模型调用，但每次调用发出去的都是**整段对话**（第 30 轮的 prompt 里带着前 29 轮），
// 直接挨个摆出来就是 30 份越来越长的重复。这里按「接着谁往下说」还原成一条时间线：
//   · 这次调用的 messages 以之前某次调用的 messages 开头 → 它是那次的下一轮，只显示多出来的部分
//     （通常是工具结果、新的用户消息），上一轮模型自己的回答不再重复
//   · 接不上任何一次（换了 system prompt 的旁路调用、上下文被压缩重写）→ 单独一条
// 系统提示、全量 prompt、原始请求 / 响应都不在这里铺开 —— 点一条再看那次调用的完整详情。

import type { MessageIR, ToolCallIR, ToolResultIR } from '../shared/types.ts';
import { splitInjected } from './history.ts';

export type TranscriptCall = {
  call_id: string;
  run_id: string;
  kind: string;
  model: string | null;
  url: string | null;
  method: string | null;
  status: number | null;
  ok: number | null;
  error: string | null;
  system: string | null;
  messages: string | null;
  response_text: string | null;
  response_tool_calls: string | null;
  finish_reason: string | null;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  started_at: number | null;
  response_preview: string | null;
  response_bytes: number | null;
};

export type TMessage = {
  role: string;
  text: string;
  truncated?: boolean;
  /** 框架拼在用户消息后面的运行时上下文（dsh 的 Current runtime context…），默认折起来 */
  context?: string;
  toolCalls?: { name: string; args: string }[];
  toolResults?: { name: string; text: string; truncated?: boolean; isError?: boolean }[];
};

export type TItem =
  | { kind: 'run'; runId: string; trigger: string | null; t: number | null }
  | {
      kind: 'llm';
      callId: string;
      runId: string;
      t: number | null;
      /** 第几轮（同一条对话里），旁路调用没有 */
      round: number | null;
      /** 这条对话是谁：主线（调用最多的那条）不标；旁路用 system prompt 的开头当名字 */
      thread: string | null;
      side: boolean;
      /** 接不上之前的对话（换了上下文 / 被压缩），这次的输入整段都算新的 */
      restart: boolean;
      model: string | null;
      ms: number | null;
      tokensIn: number | null;
      tokensOut: number | null;
      cache: number | null;
      pending: boolean;
      error: string | null;
      finish: string | null;
      input: TMessage[];
      reply: TMessage | null;
      /** 这一轮发起的工具拿回来的结果。协议里它们是作为**下一轮**的输入发给模型的，
          但人读的时候「命令 → 结果」得在一起：点「失败」跳过来，命令和报错要在同一处 */
      results: NonNullable<TMessage['toolResults']>;
    }
  | {
      kind: 'http';
      callId: string;
      runId: string;
      t: number | null;
      method: string;
      url: string;
      status: number | null;
      ok: boolean;
      ms: number | null;
      bytes: number | null;
      preview: string | null;
    };

export type Transcript = {
  /** 交给 agent 的任务（主线第一条用户消息） */
  task: TMessage | null;
  items: TItem[];
  llm: number;
  tool: number;
};

/** 单段文字的上限 —— 一轮工具结果可能几十 KB，完整的点进去看 */
const MAX_TEXT = 6000;

const clip = (s: string, max = MAX_TEXT): { text: string; truncated?: boolean } =>
  s.length > max ? { text: s.slice(0, max), truncated: true } : { text: s };

const parse = <T>(s: string | null | undefined, d: T): T => {
  if (!s) return d;
  try {
    return (JSON.parse(s) as T) ?? d;
  } catch {
    return d;
  }
};

const argText = (c: ToolCallIR) => (typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}));

/** 两条消息是不是同一条（比对话前缀用）—— 正文 + 工具调用 + 工具结果都要一样 */
function same(a: MessageIR, b: MessageIR): boolean {
  if (a.role !== b.role || a.content !== b.content) return false;
  const ca = (a.toolCalls ?? []).map((c) => `${c.name}:${argText(c)}`).join('|');
  const cb = (b.toolCalls ?? []).map((c) => `${c.name}:${argText(c)}`).join('|');
  if (ca !== cb) return false;
  const ra = (a.toolResults ?? []).map((r) => r.content).join('|');
  const rb = (b.toolResults ?? []).map((r) => r.content).join('|');
  return ra === rb;
}

/**
 * prefix 是不是 all 的开头。只抽查首、中、尾三条 —— 逐条比的话，100 轮的 agent 每轮几百条消息、
 * 每条几 KB，两两比下来是上亿次字符比较；而真正「接着往下说」的对话首尾都对得上，抽查足够区分
 */
function isPrefix(prefix: MessageIR[], all: MessageIR[]): boolean {
  const n = prefix.length;
  if (!n || n > all.length) return false;
  for (const i of new Set([0, n >> 1, n - 1])) if (!same(prefix[i], all[i])) return false;
  return true;
}

export function buildTranscript(calls: TranscriptCall[], triggers: Map<string, string | null> = new Map()): Transcript {
  const llm = calls.filter((c) => c.kind === 'llm');
  // 主线 = 调用最多的那个 system prompt（agent 循环）；其余的是旁路（起标题、压缩上下文、子任务）
  const bySystem = new Map<string, number>();
  for (const c of llm) bySystem.set(c.system ?? '', (bySystem.get(c.system ?? '') ?? 0) + 1);
  const mainSystem = [...bySystem].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  /** 已经出现过的对话：每次调用发出去的 messages + 它的回答，下一轮就接在它后面 */
  const seen: { msgs: MessageIR[]; withReply: MessageIR[]; system: string; round: number; item: Extract<TItem, { kind: 'llm' }> }[] = [];
  /** 工具调用 id → 工具名（Anthropic 的工具结果里只有 id） */
  const toolName = new Map<string, string>();

  const items: TItem[] = [];
  let task: TMessage | null = null;
  let lastRun: string | null = null;
  const multiRun = new Set(calls.map((c) => c.run_id)).size > 1;

  for (const c of [...calls].sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0))) {
    if (multiRun && c.run_id !== lastRun) {
      items.push({ kind: 'run', runId: c.run_id, trigger: triggers.get(c.run_id) ?? null, t: c.started_at });
    }
    lastRun = c.run_id;

    if (c.kind !== 'llm') {
      items.push({
        kind: 'http',
        callId: c.call_id,
        runId: c.run_id,
        t: c.started_at,
        method: c.method ?? 'GET',
        url: c.url ?? '',
        status: c.status,
        ok: c.ok !== 0 && !c.error,
        ms: c.duration_ms,
        bytes: c.response_bytes,
        preview: c.response_preview,
      });
      continue;
    }

    const msgs = parse<MessageIR[]>(c.messages, []);
    const replyCalls = parse<ToolCallIR[]>(c.response_tool_calls, []);
    for (const m of msgs) for (const tc of m.toolCalls ?? []) if (tc.id) toolName.set(tc.id, tc.name);
    for (const tc of replyCalls) if (tc.id) toolName.set(tc.id, tc.name);

    // 接在哪一次后面：messages 以它（连同它的回答）开头、而且最长的那一次
    const system = c.system ?? '';
    // 从最近的往回找：下一轮几乎总是接在同一条对话的上一次后面，找到最长的那个就停
    let base: (typeof seen)[number] | null = null;
    let tried = 0;
    for (let i = seen.length - 1; i >= 0 && tried < 8; i--) {
      const s = seen[i];
      if (s.system !== system) continue;
      tried++;
      const pre = isPrefix(s.withReply, msgs) ? s.withReply : isPrefix(s.msgs, msgs) ? s.msgs : null;
      if (pre && (!base || pre.length > base.withReply.length)) base = { ...s, withReply: pre, msgs: s.msgs };
      if (base && base.withReply.length === s.withReply.length) break;
    }
    let fresh = base ? msgs.slice(base.withReply.length) : msgs;
    // 接在上一次后面、但没对上它的回答（框架回传历史时改了格式：思考过程、工具块的写法）——
    // 紧跟着的那条助手消息就是上一轮的回答，上一轮已经显示过了
    if (base && base.withReply === base.msgs && fresh[0]?.role === 'assistant') fresh = fresh.slice(1);
    const round = base ? base.round + 1 : 1;

    let input = fresh.map((m) => toTMessage(m, toolName));
    // 工具结果挪回发起它们的那一轮（上一轮），这一轮的输入里只剩新的用户消息
    if (base) {
      for (const m of input) {
        if (m.toolResults?.length) base.item.results.push(...m.toolResults);
      }
      input = input.filter((m) => m.text || m.toolCalls?.length).map(({ toolResults: _r, ...m }) => m);
    }
    const side = system !== mainSystem;
    if (!task && !side) {
      const first = msgs.find((m) => m.role === 'user' && m.content && !(m.toolResults ?? []).length);
      if (first) task = toTMessage(first, toolName);
    }

    const reply: TMessage | null = c.response_text || replyCalls.length
      ? {
          role: 'assistant',
          ...clip(c.response_text ?? ''),
          ...(replyCalls.length ? { toolCalls: replyCalls.map((x) => ({ name: x.name, args: clip(argText(x), 2000).text })) } : {}),
        }
      : null;

    const item: Extract<TItem, { kind: 'llm' }> = {
      kind: 'llm',
      callId: c.call_id,
      runId: c.run_id,
      t: c.started_at,
      round: side ? null : round,
      thread: side ? (system.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 60) || '另一个对话' : null,
      side,
      restart: !side && !base && seen.some((s) => s.system === system),
      model: c.model,
      ms: c.duration_ms,
      tokensIn: c.input_tokens,
      tokensOut: c.output_tokens,
      cache: c.cache_read_tokens,
      pending: c.duration_ms == null && c.ok == null && !c.error,
      error: c.error,
      finish: c.finish_reason,
      // 第一轮的那条用户消息已经作为「任务」摆在最上面了，不再重复
      input: !side && round === 1 && !seen.some((s) => s.system === system) && task
        ? input.filter((m) => !(m.role === 'user' && m.text === task!.text && !m.toolResults))
        : input,
      reply,
      results: [],
    };
    items.push(item);

    const replyMsg: MessageIR | null = reply
      ? { role: 'assistant', content: c.response_text ?? '', ...(replyCalls.length ? { toolCalls: replyCalls } : {}) }
      : null;
    seen.push({ msgs, withReply: replyMsg ? [...msgs, replyMsg] : msgs, system, round, item });
  }

  return { task, items, llm: llm.length, tool: calls.length - llm.length };
}

function toTMessage(m: MessageIR, toolName: Map<string, string>): TMessage {
  const results = m.toolResults ?? [];
  // OpenAI 的 tool 消息正文就是结果本身；Anthropic 的正文只剩「«toolResult»」占位
  const bodyIsResult = results.some((r) => r.content === m.content) || /^(\s*«[^»]*»\s*)+$/.test(m.content);
  const raw = bodyIsResult ? '' : m.content;
  const { main, context } = m.role === 'user' ? splitInjected(raw) : { main: raw, context: null };
  return {
    role: m.role,
    ...clip(main),
    ...(context ? { context: clip(context, 3000).text } : {}),
    ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((x) => ({ name: x.name, args: clip(argText(x), 2000).text })) } : {}),
    ...(results.length
      ? {
          toolResults: results.map((r: ToolResultIR) => {
            const t = clip(r.content, 4000);
            return { name: r.name ?? (r.callId ? toolName.get(r.callId) : undefined) ?? '工具', text: t.text, ...(t.truncated ? { truncated: true } : {}), ...(r.isError ? { isError: true } : {}) };
          }),
        }
      : {}),
  };
}

// ── 时序：瀑布图的数据 ─────────────────────────────────────
//
// 一轮一行，同一条时间轴。每一轮两段：模型在想（这次调用本身的耗时），以及到下一轮开始之前的空档 ——
// 单线程的 agent 循环里，这段空档就是它在本地跑工具（bash、读写文件）的时间。卡住的命令（dsh 跑浏览器测试
// 挂了 120 秒）只在这里看得见：每次模型调用都正常，慢在两轮之间。

export type TimingRow = {
  callId: string;
  kind: 'round' | 'side' | 'http';
  round: number | null;
  /** 距这次运行第一个调用开始多少毫秒 */
  start: number;
  ms: number | null;
  pending: boolean;
  /** 这一行的名字：工具调用的一句话摘要（bash ls -la ×2）、旁路的对话名、HTTP 的地址 */
  label: string;
  /** 这一轮发起的工具调用，一项一句 */
  tools: string[];
  /** 模型这一轮说了什么（开头一段，悬停时看） */
  text: string;
  error: string | null;
  /** 这一轮结束到下一轮开始之间的工具执行时间；最后一轮且还在跑时是「到现在」 */
  gap: number | null;
  gapRunning: boolean;
};

export type Timing = { rows: TimingRow[]; span: number; modelMs: number; toolMs: number };

export function buildTiming(t: Transcript, opts: { live: boolean; now: number }): Timing {
  const timed = t.items.filter((i) => i.kind !== 'run' && i.t != null) as Exclude<TItem, { kind: 'run' }>[];
  const t0 = Math.min(...timed.map((i) => i.t!));
  const rounds = timed.filter((i) => i.kind === 'llm' && !i.side) as Extract<TItem, { kind: 'llm' }>[];
  const nextStart = new Map<string, number>();
  rounds.forEach((r, k) => { if (rounds[k + 1]) nextStart.set(r.callId, rounds[k + 1].t!); });

  let modelMs = 0;
  let toolMs = 0;
  const rows: TimingRow[] = timed.map((i) => {
    if (i.kind === 'http') {
      return {
        callId: i.callId, kind: 'http', round: null, start: i.t! - t0, ms: i.ms, pending: i.ms == null, label: `${i.method} ${shortUrl(i.url)}`,
        tools: [], text: i.preview ?? '', error: i.ok ? null : `HTTP ${i.status ?? '失败'}`, gap: null, gapRunning: false,
      };
    }
    const tools = (i.reply?.toolCalls ?? []).map((c) => `${c.name} ${argBrief(c.args)}`.trim());
    const end = i.t! + (i.ms ?? 0);
    let gap: number | null = null;
    let gapRunning = false;
    if (!i.side) {
      modelMs += i.ms ?? 0;
      const nx = nextStart.get(i.callId);
      if (nx != null) gap = Math.max(0, nx - end);
      else if (opts.live && !i.pending && tools.length) {
        gap = Math.max(0, opts.now - end); // 最后一轮发起了工具、还没回到模型：工具正在跑
        gapRunning = true;
      }
      toolMs += gap ?? 0;
    }
    return {
      callId: i.callId,
      kind: i.side ? 'side' : 'round',
      round: i.round,
      start: i.t! - t0,
      ms: i.ms,
      pending: i.pending,
      label: i.side ? (i.thread ?? '旁路') : toolLabel(i.reply?.toolCalls ?? []),
      tools,
      text: (i.reply?.text ?? '').slice(0, 300),
      error: i.error,
      gap,
      gapRunning,
    };
  });
  const span = Math.max(0, ...rows.map((r) => r.start + (r.ms ?? 0) + (r.gap ?? 0)));
  return { rows, span, modelMs, toolMs };
}

/** 一轮的名字：只有一个工具就写它的参数摘要；多个同名的写「bash ×2」；不调工具的就是在作答 */
function toolLabel(calls: { name: string; args: string }[]): string {
  if (!calls.length) return '作答';
  if (calls.length === 1) return `${calls[0].name} ${argBrief(calls[0].args)}`.trim();
  const names = [...new Set(calls.map((c) => c.name))];
  return names.length === 1 ? `${names[0]} ×${calls.length}` : names.join(' · ');
}

/** 参数的一句话：常见的 command / path / query 直接取值，其余取紧凑 JSON 的开头 */
export function argBrief(args: string): string {
  try {
    const o = JSON.parse(args);
    if (o && typeof o === 'object') {
      for (const k of ['command', 'cmd', 'path', 'file_path', 'query', 'q', 'url', 'pattern', 'job_id', 'description']) {
        if (typeof o[k] === 'string') return o[k].replace(/\s+/g, ' ').slice(0, 80);
      }
    }
  } catch {
    // 很长的参数在完整记录里被截断过，已经不是合法 JSON —— 直接从开头把常见字段抠出来
    const m = /"(command|cmd|path|file_path|query|q|url|pattern|job_id)"\s*:\s*"((?:[^"\\]|\\.){0,200})/.exec(String(args));
    if (m) return m[2].replace(/\\n/g, ' ').replace(/\\(.)/g, '$1').replace(/\s+/g, ' ').slice(0, 80);
  }
  return String(args).replace(/\s+/g, ' ').slice(0, 80);
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`;
  } catch {
    return u;
  }
}

// ── 循环图：agent 和它的工具之间转了些什么 ─────────────────────
//
// 流程图按「哪一行代码发的调用」归并步骤，对 agent 循环几乎没用：dsh 的 103 轮都从同一处发出，
// 只剩一张「×103」的卡片，而它真正在做的事 —— 用 bash 跑了 148 次命令、4 次退出码不为 0、
// 杀掉一个卡住的任务 —— 全藏在模型回答里的工具调用中，图上一个都没有。
// 这里从完整记录里把工具调用和工具结果拎出来：每个工具调了几次、失败几次、花了多久、最近一次干了什么。

export type LoopTool = {
  name: string;
  count: number;
  failed: number;
  /** 这个工具花的时间：它所在那一轮之后的空档，按这一轮发起的工具个数平摊 */
  ms: number;
  /** 工具结果的总字数（回到模型那里的数据量） */
  outChars: number;
  last: { args: string; result: string | null } | null;
  /** 发起过它的那几轮（模型调用 id）—— 点工具时在时序和完整记录里亮这几轮 */
  callIds: string[];
  failedCallIds: string[];
};

export type LoopMap = {
  task: string | null;
  model: { rounds: number; models: string[]; ms: number; tokensIn: number; tokensOut: number; firstCallId: string | null };
  tools: LoopTool[];
  side: { name: string; count: number; callIds: string[] }[];
  http: { count: number; callIds: string[] };
  final: { text: string; callId: string; round: number | null } | null;
  /** 最后一轮还在等模型或工具 —— 还在跑 */
  running: boolean;
};

/**
 * 工具结果算不算失败：协议标了错，或者框架写在结果里的退出码不是 0（dsh 是结尾的「[exit code: 1]」，
 * 以最后一个为准）。不认输出正文里随手出现的「exited with code 1」—— 那常常是被测程序打的日志，
 * 命令本身好好的，算成失败就是误报
 */
export function toolFailed(r: { text: string; isError?: boolean }): boolean {
  if (r.isError) return true;
  const codes = [...r.text.matchAll(/\[exit code:\s*(-?\d+)\]/gi)];
  return codes.length > 0 && Number(codes.at(-1)![1]) !== 0;
}

export function buildLoopMap(t: Transcript): LoopMap {
  const rounds = t.items.filter((i) => i.kind === 'llm' && !i.side) as Extract<TItem, { kind: 'llm' }>[];
  const tools = new Map<string, LoopTool>();
  const tool = (name: string) => {
    let x = tools.get(name);
    if (!x) tools.set(name, (x = { name, count: 0, failed: 0, ms: 0, outChars: 0, last: null, callIds: [], failedCallIds: [] }));
    return x;
  };

  rounds.forEach((r, k) => {
    const calls = r.reply?.toolCalls ?? [];
    const next = rounds[k + 1];
    const gap = next && next.t != null && r.t != null ? Math.max(0, next.t - (r.t + (r.ms ?? 0))) : 0;
    for (const c of calls) {
      const x = tool(c.name);
      x.count++;
      x.ms += calls.length ? gap / calls.length : 0;
      if (!x.callIds.includes(r.callId)) x.callIds.push(r.callId);
      x.last = { args: argBrief(c.args), result: null };
    }
    // 这一轮发起的工具拿回来的结果（完整记录里已经挪回了这一轮）
    for (const res of r.results) {
      const x = tool(res.name);
      x.outChars += res.text.length;
      if (x.last && x.callIds.at(-1) === r.callId) x.last.result = res.text.replace(/\s+/g, ' ').slice(0, 120);
      if (toolFailed(res)) {
        x.failed++;
        if (!x.failedCallIds.includes(r.callId)) x.failedCallIds.push(r.callId);
      }
    }
  });

  const side = new Map<string, { name: string; count: number; callIds: string[] }>();
  const httpIds: string[] = [];
  for (const i of t.items) {
    if (i.kind === 'llm' && i.side) {
      const s = side.get(i.thread ?? '') ?? { name: i.thread ?? '旁路', count: 0, callIds: [] };
      s.count++;
      s.callIds.push(i.callId);
      side.set(i.thread ?? '', s);
    }
    if (i.kind === 'http') httpIds.push(i.callId);
  }

  const last = rounds.at(-1);
  const final = last && !last.pending && !(last.reply?.toolCalls?.length) && last.reply?.text
    ? { text: plain(last.reply.text).slice(0, 200), callId: last.callId, round: last.round }
    : null;

  return {
    task: t.task ? plain(t.task.text).slice(0, 200) : null,
    model: {
      rounds: rounds.length,
      models: [...new Set(rounds.map((r) => r.model).filter(Boolean) as string[])],
      ms: rounds.reduce((n, r) => n + (r.ms ?? 0), 0),
      tokensIn: rounds.reduce((n, r) => n + (r.tokensIn ?? 0), 0),
      tokensOut: rounds.reduce((n, r) => n + (r.tokensOut ?? 0), 0),
      firstCallId: rounds[0]?.callId ?? null,
    },
    // 花时间最多的在前：最该看的工具放最上面
    tools: [...tools.values()].sort((a, b) => b.ms - a.ms || b.count - a.count),
    side: [...side.values()],
    http: { count: httpIds.length, callIds: httpIds },
    final,
    running: !!last && (last.pending || !!(last.reply?.toolCalls?.length) && !final),
  };
}

/** 卡片上放的一句话：去掉 Markdown 的符号（## 标题、**加粗**、`代码`），只留字 */
function plain(s: string): string {
  return s.replace(/```[\s\S]*?```/g, ' ').replace(/^#+\s*/gm, '').replace(/[*_`>]+/g, '').replace(/\s+/g, ' ').trim();
}
