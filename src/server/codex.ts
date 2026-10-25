// Codex 接入：实时读 ~/.codex/sessions 里的会话记录，转成 AgentMake 的运行和调用。
//
// 为什么不用探针 / 代理：本机的 codex 是原生程序（CodexCLI.app），NODE_OPTIONS / PYTHONPATH 都挂不上去；
// 用 ChatGPT 账号登录时它直连 chatgpt.com/backend-api/codex，代理既不认识这个路径、也会把流式回答憋住，
// 还得让登录凭据经过本机代理。而 Codex 自己把每次会话完整写在本机：消息、工具调用与输出、每次模型回答的
// token、每一项的时间 —— 读它就够了，不碰 Codex 的配置和凭据。代价：只能看，不能打断点、不能重放。
//
// 对应关系：
//   一个会话文件（thread）  → 进程级运行  codex_<threadId>
//   会话里的一轮对话（turn）→ 请求级运行  codex_<threadId>_<turn>，挂在会话下面（历史栏里每轮一条）
//   一次模型回答            → 一次模型调用：输入是这一轮到此为止的对话，输出是它说的话和发起的工具调用
//   子 agent / 审查（guardian）→ 单独的会话文件，自成一个运行（不再按轮切开），挂在拉起它的那一轮下面
// 调用 id 由文件和序号决定，重启后重新读同一个文件不会重复入库。

import { closeSync, existsSync, openSync, readdirSync, readSync, statSync, watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, LLMRequestIR, LLMResponseIR, MessageIR, ToolCallIR } from '../shared/types.ts';

/** 写进 messages 的工具输出最多留多少字 —— 每次调用都带着这一轮到此为止的整段对话，不截会把库撑大 */
const TOOL_OUT_CAP = 2000;

type Line = { type: string; timestamp?: string; payload?: any };

/** 解析出来要交给 record() 的一个事件（runId / seq / ts 都已经填好） */
export type Emit = AgentEvent;

type Seg = {
  startTs: number;
  endTs: number;
  texts: string[];
  calls: ToolCallIR[];
  usage: { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null } | null;
  final: boolean;
};

/**
 * 一个会话文件的解析器。一行一行喂进去，吐出 AgentMake 的事件。
 * 只认会话自己的内容：分叉出来的会话开头会整段复制父会话的历史，那一段跳过（父会话自己的文件里有）。
 */
export class CodexThread {
  readonly file: string;
  threadId: string | null = null;
  runId: string | null = null;
  private meta: any = null;
  private metaWriteTs = 0;
  private model = 'codex';
  private seq = 0;
  private callNo = 0;
  private turn: { id: string; runId: string; msgs: MessageIR[]; lastInputTs: number; seg: Seg | null } | null = null;
  private toolNames = new Map<string, string>();
  private out: Emit[] = [];
  /** 库里已经有的（重启后重读同一个文件）：不再发 —— 由外面注入 */
  private known: Known;
  /** 读到第几行（从 0 数，含 session_meta） */
  private lineNo = 0;
  /** 子 agent 的会话文件开头整段复制了父会话的历史：从这一行起才是它自己的 */
  private ownFrom = 0;
  /** 老格式没给 ownFrom：看到第二条 session_meta 就进入「复制段」，直到它自己的第一轮开始 */
  private replaying = false;
  /** 子 agent / 审查：父会话的 id。它的运行等到自己第一轮开始、知道是父会话哪一轮拉起的，才登记 */
  private parentThread: string | null = null;
  private started = false;

  constructor(file: string, known: Known = NONE_KNOWN) {
    this.file = file;
    this.known = known;
  }

  /** 喂一批完整的行，返回这批产生的事件 */
  feed(lines: string[]): Emit[] {
    this.out = [];
    for (const raw of lines) {
      if (!raw.trim()) continue;
      let o: Line;
      try {
        o = JSON.parse(raw);
      } catch {
        continue; // 写到一半的行由调用方留着下次再喂，这里是真坏行
      }
      this.line(o);
    }
    return this.out;
  }

  private emit(ev: Record<string, unknown> & { type: string; runId: string; ts: number }): void {
    const seq = this.seq++;
    const st = ev.type === 'run.started' || ev.type === 'run.ended' ? this.known.run(ev.runId) : undefined;
    if (ev.type === 'run.started' && st !== undefined) return;
    if (ev.type === 'run.ended' && typeof st === 'number' && st >= ev.ts) return;
    this.out.push({ ...ev, seq } as unknown as Emit);
  }

  private line(o: Line): void {
    const p = o.payload ?? {};
    const writeTs = o.timestamp ? Date.parse(o.timestamp) : Date.now();
    const lineNo = this.lineNo++;

    if (o.type === 'session_meta') {
      if (this.meta) {
        // 第一条才是这个会话自己的；后面的是复制过来的父会话
        if (!this.ownFrom) this.replaying = true;
        return;
      }
      this.meta = p;
      this.ownFrom = typeof p.subagent_history_start_ordinal === 'number' ? p.subagent_history_start_ordinal : 0;
      this.metaWriteTs = writeTs;
      this.threadId = String(p.id ?? path.basename(this.file, '.jsonl'));
      this.runId = `codex_${this.threadId}`;
      this.parentThread = p.parent_thread_id && p.parent_thread_id !== p.id ? String(p.parent_thread_id) : null;
      if (!this.parentThread) this.startThread(Date.parse(p.timestamp ?? '') || writeTs, null);
      return;
    }
    if (!this.meta || !this.runId) return;

    // 子 agent / 分叉出来的会话：开头那一段是父会话历史的复制（父会话自己的文件里有），跳过
    if (lineNo < this.ownFrom) return;
    if (this.replaying) {
      const own = o.type === 'event_msg' && p.type === 'task_started' && (p.started_at ?? 0) * 1000 >= this.metaWriteTs - 2000;
      if (!own && writeTs - this.metaWriteTs < 10_000) return;
      this.replaying = false;
    }
    const created = itemTime(p);
    const ts = created ?? writeTs;

    if (o.type === 'turn_context' && p.model) this.model = String(p.model);
    if (o.type === 'world_state' && p.state?.collaboration_mode?.model) this.model = String(p.state.collaboration_mode.model);

    if (o.type === 'event_msg') {
      if (p.type === 'task_started') {
        const at = p.started_at ? p.started_at * 1000 : ts;
        const parentTurn = p.turn_attribution?.parent_turn_id;
        if (!this.started) {
          // 父会话自己也是子 agent（审查子 agent 的那一轮）时它不按轮切，没有这一轮的运行 —— 挂父会话本身
          const byTurn = parentTurn ? turnRunId(this.parentThread!, String(parentTurn)) : null;
          this.startThread(at, byTurn && this.known.run(byTurn) !== undefined ? byTurn : null);
        }
        this.startTurn(String(p.turn_id ?? p.root_turn_id ?? `t${this.seq}`), at);
      }
      else if (p.type === 'task_complete' || p.type === 'turn_aborted') this.endTurn(p.completed_at ? p.completed_at * 1000 : ts);
      return;
    }

    if (o.type === 'token_usage_record') {
      // 一次模型回答结束：它的 token 记录紧跟在它产出的那几项后面 —— 这一段就此收口
      const u = p.usage ?? {};
      const seg = this.turn?.seg;
      if (seg) {
        seg.usage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cached_input_tokens) };
        seg.endTs = Math.max(seg.endTs, writeTs);
        this.closeSeg();
      }
      return;
    }

    if (o.type !== 'response_item') return;
    if (!this.turn) {
      // 没有 task_started 的老格式：自己开一轮
      if (!this.started) this.startThread(ts, null);
      this.startTurn(`t${this.seq}`, ts);
    }
    const turn = this.turn!;

    switch (p.type) {
      case 'message': {
        const text = contentText(p.content);
        if (p.role === 'assistant') {
          this.openSeg(ts).texts.push(text);
          if (p.phase === 'final_answer') turn.seg!.final = true;
          turn.seg!.endTs = Math.max(turn.seg!.endTs, ts);
        } else if (p.role === 'user' && kinds(p).includes('user.text')) {
          this.closeSeg();
          turn.msgs.push({ role: 'user', content: text.trim() });
          turn.lastInputTs = ts;
        }
        // developer 消息、环境上下文之类是框架注入的说明，不算对话
        return;
      }
      case 'reasoning':
        this.openSeg(ts);
        return;
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
      case 'web_search_call': {
        const seg = this.openSeg(ts);
        const id = String(p.call_id ?? p.id ?? `c${this.seq}`);
        const name = String(p.name ?? p.type.replace(/_call$/, ''));
        let args: unknown = {};
        if (typeof p.arguments === 'string') {
          try { args = JSON.parse(p.arguments); } catch { args = p.arguments; }
        } else if (typeof p.input === 'string') args = { input: p.input };
        else if (p.action) args = p.action;
        seg.calls.push({ id, name: p.namespace && p.namespace !== 'functions' ? `${p.namespace}.${name}` : name, args });
        this.toolNames.set(id, name);
        seg.endTs = Math.max(seg.endTs, ts);
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        this.closeSeg();
        const out = typeof p.output === 'string' ? p.output : contentText(p.output) || JSON.stringify(p.output ?? '');
        const callId = String(p.call_id ?? '');
        turn.msgs.push({
          role: 'user',
          content: '«toolResult»',
          toolResults: [{ callId, name: this.toolNames.get(callId) ?? null, content: clip(out, TOOL_OUT_CAP) }],
        });
        turn.lastInputTs = ts;
        return;
      }
      case 'agent_message': {
        // 子 agent 交回来的话：对主 agent 来说是一条新的输入
        this.closeSeg();
        turn.msgs.push({ role: 'user', content: `[${p.author ?? '子 agent'}] ${contentText(p.content)}`.trim() });
        turn.lastInputTs = ts;
        return;
      }
      default:
        return;
    }
  }

  /** 会话本身登记成一个进程级运行。子 agent / 审查挂在拉起它的那一轮（不知道是哪一轮就挂父会话）下面 */
  private startThread(ts: number, spawnedBy: string | null): void {
    this.started = true;
    const p = this.meta;
    this.emit({
      type: 'run.started',
      runId: this.runId!,
      ts: Math.min(ts, Date.parse(p.timestamp ?? '') || ts),
      kind: 'process',
      cwd: p.cwd ?? '',
      argv: ['codex', programLabel(p)],
      pid: null,
      ...(this.parentThread ? { spawnedBy: spawnedBy ?? `codex_${this.parentThread}` } : {}),
    });
  }

  private startTurn(id: string, ts: number): void {
    if (this.turn) this.endTurn(ts);
    // 子 agent / 审查一般就一两轮，不再切开 —— 调用直接记在它自己的运行上，挂在父会话那一轮下面一眼能看到
    const runId = this.parentThread ? this.runId! : turnRunId(this.threadId!, id);
    this.turn = { id, runId, msgs: [], lastInputTs: ts, seg: null };
    if (!this.parentThread) {
      this.emit({ type: 'run.started', runId, ts, kind: 'request', parentRunId: this.runId!, trigger: 'Codex 对话', cwd: this.meta?.cwd ?? '', argv: [], pid: null });
    }
  }

  private endTurn(ts: number): void {
    if (!this.turn) return;
    this.closeSeg();
    this.emit({ type: 'run.ended', runId: this.turn.runId, ts, exitCode: null });
    this.turn = null;
  }

  private openSeg(ts: number): Seg {
    const turn = this.turn!;
    if (!turn.seg) turn.seg = { startTs: turn.lastInputTs, endTs: ts, texts: [], calls: [], usage: null, final: false };
    return turn.seg;
  }

  /** 一次模型回答收口：发出这次调用（输入 = 这一轮到此为止的对话，输出 = 它说的话 + 发起的工具调用） */
  private closeSeg(): void {
    const turn = this.turn;
    const seg = turn?.seg;
    if (!turn || !seg) return;
    turn.seg = null;
    const callId = `${this.runId}_${this.callNo++}`;
    const text = seg.texts.map((t) => t.trim()).filter(Boolean).join('\n\n');
    // 这次回答进入对话 —— 下一次调用的输入以它为前缀，完整记录据此还原成一轮一轮
    turn.msgs.push({ role: 'assistant', content: text, ...(seg.calls.length ? { toolCalls: seg.calls } : {}) });
    if (this.known.call(callId)) return;

    const request: LLMRequestIR = {
      provider: 'openai_responses',
      model: this.model,
      system: typeof this.meta?.base_instructions === 'string' ? this.meta.base_instructions : null,
      messages: turn.msgs.slice(0, -1),
      tools: [],
      params: {},
      raw: { source: 'codex', file: path.basename(this.file) },
    };
    const response: LLMResponseIR = {
      text,
      toolCalls: seg.calls,
      // 只有推理、没说话也没调工具：模型在让出（等子 agent / 异步结果），不是空输出
      finishReason: seg.calls.length ? 'tool_calls' : text ? 'stop' : 'reasoning_only',
      usage: seg.usage ?? { inputTokens: null, outputTokens: null, cacheReadTokens: null },
      raw: null,
    };
    const start = Math.min(seg.startTs, seg.endTs);
    this.emit({ type: 'llm.before', runId: turn.runId, ts: start, callId, url: 'https://chatgpt.com/backend-api/codex/responses', request, frames: [] });
    this.emit({
      type: 'llm.after', runId: turn.runId, ts: seg.endTs, callId, ok: true, status: 200,
      durationMs: Math.max(0, seg.endTs - start), response, error: null, streaming: false,
    });
  }
}

/** 库里已经有什么。run：undefined = 没有这个运行 · null = 有、没结束 · 数字 = 结束时间 */
export type Known = { call: (callId: string) => boolean; run: (runId: string) => number | null | undefined };
const NONE_KNOWN: Known = { call: () => false, run: () => undefined };

/** 一轮对话的运行 id —— 子 agent 要据此找到拉起它的那一轮，两边必须算得一样 */
export function turnRunId(threadId: string, turnId: string): string {
  return `codex_${threadId}_${turnId.replace(/[^\w-]/g, '').slice(-12)}`;
}

/** 历史栏里的程序名第二段：codex desktop / codex cli / codex 子agent·Laplace / codex 审查 */
function programLabel(p: any): string {
  if (p.agent_nickname || p.agent_path) return `子agent·${p.agent_nickname ?? String(p.agent_path).split('/').pop()}`;
  if (p.thread_source === 'guardian_review' || p.source?.subagent?.other === 'guardian') return '审查';
  if (p.source?.subagent) return '子agent';
  const o = String(p.originator ?? '').toLowerCase();
  return o.includes('desktop') ? 'desktop' : o.includes('vscode') ? 'vscode' : 'cli';
}

const num = (v: unknown) => (typeof v === 'number' ? v : null);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（共 ${s.length} 字，只记了前 ${n} 字）` : s);
const kinds = (p: any): string[] => p?.internal_chat_message_metadata_passthrough?.content_item_kinds ?? [];

/** 这一项真正发生的时间：Codex 记在元数据里（秒）；没有就用 null，调用方退回写入时间 */
function itemTime(p: any): number | null {
  const ct = p?.internal_chat_message_metadata_passthrough?.create_time;
  if (typeof ct === 'number') return ct * 1000;
  if (typeof p?.completed_at_ms === 'number') return p.completed_at_ms;
  return null;
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((x: any) => (typeof x === 'string' ? x : x?.text ?? '')).filter(Boolean).join('\n');
}

// ── 实时跟随 ───────────────────────────────────────────────

export type CodexWatcherDeps = {
  record: (ev: AgentEvent) => void;
  known: Known;
  log?: (msg: string) => void;
};

/** Codex 的会话目录（CODEX_HOME 可以改） */
export function codexSessionsDir(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
}

/**
 * 开始跟随：先补读最近 N 天（AGENTMAKE_CODEX_DAYS，缺省 1）改动过的会话，之后有新会话或新内容就接着读。
 * 只读不写，读不到就安静地什么都不做。返回停止函数。
 */
export function startCodexWatcher(deps: CodexWatcherDeps, opts: { dir?: string; days?: number; pollMs?: number } = {}): () => void {
  const dir = opts.dir ?? codexSessionsDir();
  if (!existsSync(dir)) return () => {};
  const since = Date.now() - (opts.days ?? Number(process.env.AGENTMAKE_CODEX_DAYS ?? 1)) * 86_400_000;
  const files = new Map<string, { thread: CodexThread; offset: number; rest: string }>();

  const pump = (file: string) => {
    let st;
    try {
      st = statSync(file);
    } catch {
      return;
    }
    let f = files.get(file);
    if (!f) {
      if (st.mtimeMs < since) return;
      f = { thread: new CodexThread(file, deps.known), offset: 0, rest: '' };
      files.set(file, f);
    }
    if (st.size <= f.offset) return;
    // 一次最多读 8MB，读不完下一轮接着读 —— 不让一个大文件卡住服务
    const len = Math.min(st.size - f.offset, 8 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, f.offset);
    } finally {
      closeSync(fd);
    }
    f.offset += len;
    const text = f.rest + buf.toString('utf8');
    const cut = text.lastIndexOf('\n');
    f.rest = cut < 0 ? text : text.slice(cut + 1); // 写到一半的最后一行留着下次拼上
    const lines = cut < 0 ? [] : text.slice(0, cut).split('\n');
    for (const ev of f.thread.feed(lines)) {
      try {
        deps.record(ev);
      } catch (e) {
        deps.log?.(`codex: 记录失败 ${e instanceof Error ? e.message : e}`);
      }
    }
  };

  const scan = () => {
    for (const file of walk(dir)) pump(file);
  };

  // 先把最近的补上（每个文件让一下事件循环，别让启动卡住）
  const initial = walk(dir).filter((f) => {
    try { return statSync(f).mtimeMs >= since; } catch { return false; }
  }).sort();
  let i = 0;
  const step = () => {
    if (i >= initial.length) return;
    pump(initial[i++]);
    setImmediate(step);
  };
  step();
  if (initial.length) deps.log?.(`codex: 跟随 ${dir}（补读最近改动的 ${initial.length} 个会话）`);

  // 变化通知 + 兜底轮询（fs.watch 在某些文件系统上会漏事件）
  let watcher: ReturnType<typeof watch> | null = null;
  try {
    watcher = watch(dir, { recursive: true }, (_e, name) => {
      if (name && String(name).endsWith('.jsonl')) pump(path.join(dir, String(name)));
    });
  } catch {
    watcher = null;
  }
  const timer = setInterval(scan, opts.pollMs ?? 3000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  const go = (d: string) => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (e.name.endsWith('.jsonl')) out.push(p);
    }
  };
  go(dir);
  return out;
}
