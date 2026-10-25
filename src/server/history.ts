// 历史：按「一次干活」列出过去的运行，让人认得出、找得到上次那一次。
//
// 下拉框里一行一个 run 的做法不适合找记录：
//   · 认不出：一行只有「03:46 POST /api/session/prompt」或者目录名，看不出那次在干什么
//   · 找不到：常驻服务、子进程、健康检查、测试脚本……上百条混在一起，真正要看的被淹没
//
// 这里的一条 = 一次干活：
//   · 一次性脚本 = 它的进程运行
//   · 常驻服务（dsh web 这种）= 每一个入站请求（每一轮对话）各自一条，进程本身不单列
//   · 被拉起的子进程挂在拉起它的那一条下面，不单列；除非拉起它的只是个不调模型的包装进程
//     （npm start → node agent.mjs），那子进程就是那一条
//   · 一次模型都没调过的运行（健康检查、空进程、只抓了点数据的脚本）不列，只报个数 ——
//     这是 agent 调试器，没调模型的不是「agent 干了一次活」
//
// 每一条带上人认得出的东西：那次你交给 agent 的任务原文（第一条用户消息）、程序名、
// 时间与时长、调了几次模型 / 工具、token、有没有失败、是不是还在跑。

export type HistoryRun = {
  run_id: string;
  kind: string | null;
  parent_run_id: string | null;
  spawned_by: string | null;
  group_id?: string | null;
  trigger: string | null;
  cwd: string | null;
  argv: string | null;
  pid: number | null;
  started_at: number;
  ended_at: number | null;
  replay_of: string | null;
};

export type RunStats = {
  llm: number;
  tool: number;
  tokensIn: number;
  tokensOut: number;
  errors: number;
  pending: number;
  firstAt: number | null;
  lastAt: number | null;
  models: string | null;
};

export type HistoryEntry = {
  /** 归到哪一批（见 HistoryBatch） */
  batchKey: string;
  runId: string;
  kind: 'process' | 'request';
  /** 哪个程序：dsh web · deepseekhsh */
  program: string;
  /** 触发它的请求（常驻服务的一轮），一次性脚本没有 */
  trigger: string | null;
  /** 那次交给 agent 的任务 —— 第一条用户消息，人靠它认出是哪一次 */
  task: string | null;
  startedAt: number;
  /** 到最后一次调用结束（或运行结束）为止 */
  endedAt: number | null;
  status: 'running' | 'done' | 'failed' | 'interrupted';
  llm: number;
  tool: number;
  tokens: number;
  errors: number;
  failing: number;
  models: string[];
  replayOf: string | null;
  /** 它拉起的子进程：多少个、其中多少个调了模型（展开看） */
  children: { runId: string; program: string; calls: number }[];
};

/**
 * 一批：左栏的第一层，收起时一行就能看出「这一批干了什么、有没有问题」。
 *   service = 一次服务启动（dsh web 起来一次），下面是这次启动期间的每一轮对话
 *   group   = 显式分的组（AGENTMAKE_GROUP，比如一轮回归）
 *   session = 其余一次性脚本：同一目录里前后相隔不到 10 分钟的连续几次（反复改反复跑）
 */
export type HistoryBatch = {
  id: string;
  kind: 'service' | 'group' | 'session';
  title: string;
  /** 整批一起看时选哪个范围（服务 = 进程运行，组 = 组名）；session 没有 */
  scope: string | null;
  startedAt: number;
  endedAt: number | null;
  status: HistoryEntry['status'];
  llm: number;
  tool: number;
  tokens: number;
  bad: number;
  entries: HistoryEntry[];
};

export type History = {
  batches: HistoryBatch[];
  /** 平铺的全部条目（新到旧）—— 默认选中「最近一次干过活的」用 */
  entries: HistoryEntry[];
  /** 没列出来的：一次模型都没调过的运行个数 */
  hiddenEmpty: number;
};

/** 同一目录里两次运行相隔多久以内算同一批 */
const SESSION_GAP_MS = 10 * 60 * 1000;

const EMPTY: RunStats = { llm: 0, tool: 0, tokensIn: 0, tokensOut: 0, errors: 0, pending: 0, firstAt: null, lastAt: null, models: null };

/** 没有进程可查的运行（读会话记录接入的 Codex）：多久没有新调用就不再算「在跑」。
    Codex 一次回答要等它想完才落盘，中间可能隔好几分钟 */
export const LOG_IDLE_MS = 10 * 60_000;

export function programName(r: { argv: string | null; cwd: string | null; run_id: string }): string {
  let argv: unknown = [];
  try {
    argv = JSON.parse(r.argv ?? '[]');
  } catch {
    argv = [];
  }
  const a = Array.isArray(argv) ? argv.map(String) : [];
  const a0 = a[0] ? a[0].split('/').pop()! : '';
  const a1 = a[1] && !a[1].startsWith('-') && !a[1].includes('/') ? ` ${a[1]}` : '';
  const dir = (r.cwd ?? '').split('/').pop() ?? '';
  if (!a0) return dir || '没记下程序名'; // 很早的记录没存 argv / cwd —— 给 run id 的话每条都不一样，批次也收不拢
  return `${a0}${a1}${dir ? ` · ${dir}` : ''}`;
}

/**
 * 任务原文的清理：agent 框架常把运行时上下文直接拼在用户消息后面（dsh 是「…有没有bugCurrent runtime context.」，
 * 连换行都没有），列表里只要人写的那一句。
 */
const INJECTED = /(Current runtime context|<system-reminder>|<environment_details>|<env>|<context>|<user-context>)/;

const LEADING = /^\s*(?:<([\w-]+)[^>]*>[\s\S]*?<\/\1>\s*)+(?:#+\s*My request:\s*)?/i;

/** 把用户消息拆成「人写的那句」和「框架拼在前后的运行时上下文」 */
export function splitInjected(text: string): { main: string; context: string | null } {
  // 拼在前面的界面状态块：Codex 的「<in-app-browser-context …>…</in-app-browser-context>## My request:」
  const lead = LEADING.exec(text);
  if (lead && lead[0].length < text.length) {
    const rest = splitInjected(text.slice(lead[0].length));
    return { main: rest.main, context: [lead[0].trim(), rest.context].filter(Boolean).join('\n\n') };
  }
  const m = INJECTED.exec(text);
  if (!m || m.index === 0) return { main: text, context: null };
  return { main: text.slice(0, m.index).trimEnd(), context: text.slice(m.index) };
}

export function cleanTask(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  let t = splitInjected(String(text)).main;
  t = t.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export function buildHistory(input: {
  runs: HistoryRun[];
  stats: Map<string, RunStats>;
  failing: Map<string, number>;
  tasks: Map<string, string | null>;
  /** 进程还在不在（按 pid 查）—— 进程被杀掉时运行永远收不到 run.ended，不能一直显示「在跑」 */
  alive: (pid: number) => boolean;
  now: number;
  q?: string;
  limit?: number;
}): History {
  const { runs, stats, failing, tasks, alive } = input;
  const byId = new Map(runs.map((r) => [r.run_id, r]));
  const st = (id: string) => stats.get(id) ?? EMPTY;
  const own = (id: string) => st(id).llm + st(id).tool;
  const llmOf = (id: string) => st(id).llm;
  const requestsOf = new Map<string, HistoryRun[]>();
  for (const r of runs) {
    if (r.kind === 'request' && r.parent_run_id) requestsOf.set(r.parent_run_id, [...(requestsOf.get(r.parent_run_id) ?? []), r]);
  }
  /** 一个运行连同它处理过的请求，总共有多少调用 —— 判断它是不是「只是个包装进程」 */
  const total = (id: string) => own(id) + (requestsOf.get(id) ?? []).reduce((n, k) => n + own(k.run_id), 0);
  /**
   * 子进程挂到谁身上：拉起它的运行。例外是顶层的包装进程（你直接 npm start，npm 自己一次调用都没有）——
   * 那子进程自己就是一条。包装进程本身挂在别人下面时（dsh 跑 npm test → run-e2e.mjs），
   * 它的子进程跟着一起挂着，不能被提到顶层
   */
  const memo = new Map<string, string | null>();
  const holder = (r: HistoryRun, depth = 0): string | null => {
    if (memo.has(r.run_id)) return memo.get(r.run_id)!;
    const s = r.spawned_by ? byId.get(r.spawned_by) : undefined;
    let h: string | null = null;
    if (s && depth < 50) {
      // 请求级运行拉起的，看它所在的进程算不算包装
      const proc = s.kind === 'request' && s.parent_run_id ? s.parent_run_id : s.run_id;
      h = total(proc) > 0 || holder(s, depth + 1) ? s.run_id : null;
    }
    memo.set(r.run_id, h);
    return h;
  };

  const rootPid = (r: HistoryRun): number | null => {
    const p = r.kind === 'request' && r.parent_run_id ? byId.get(r.parent_run_id) : r;
    return p?.pid ?? null;
  };

  const kids = new Map<string, HistoryRun[]>();
  for (const r of runs) {
    const h = holder(r);
    if (h) kids.set(h, [...(kids.get(h) ?? []), r]);
  }

  const descendants = (id: string): HistoryRun[] => {
    const out: HistoryRun[] = [];
    const seen = new Set<string>([id]);
    const walk = (x: string) => {
      for (const k of kids.get(x) ?? []) {
        if (seen.has(k.run_id)) continue;
        seen.add(k.run_id);
        out.push(k);
        walk(k.run_id);
      }
    };
    walk(id);
    return out;
  };

  let hiddenEmpty = 0;
  const entries: HistoryEntry[] = [];
  for (const r of runs) {
    if (holder(r)) continue; // 挂在别人下面
    if (llmOf(r.run_id) === 0) {
      // 常驻服务进程本身没有调用，它的请求各自成条 —— 不算「空」
      if (!(requestsOf.get(r.run_id) ?? []).some((k) => llmOf(k.run_id) > 0)) hiddenEmpty++;
      continue;
    }
    const s = st(r.run_id);
    const procEnded = r.kind === 'request' && r.parent_run_id ? byId.get(r.parent_run_id)?.ended_at ?? null : r.ended_at;
    const pid = rootPid(r);
    // 在跑 = 进程还在，且这一条确实还在动：有调用没回来，或者刚刚还有调用。
    // 只看 run.ended 不够：dsh 这类服务收到一轮对话的请求就先回了，agent 在后台接着跑；
    // 反过来，长连接的请求一直不结束，却早就不干活了
    const procAlive = procEnded == null && pid != null && alive(pid);
    const live = procAlive ? (s.pending > 0 || (s.lastAt != null && input.now - s.lastAt < 15_000) ||
      (r.kind !== 'request' && r.ended_at == null))
      // 读会话记录接入的（Codex）没有进程可查：这一轮没结束、最近还在写，就算在跑
      : pid == null && r.ended_at == null && s.lastAt != null && input.now - s.lastAt < LOG_IDLE_MS;
    const fail = failing.get(r.run_id) ?? 0;
    // 「中断」只算进程没了的时候还有调用没回来的 —— 一轮对话早就跑完、只是后来进程被关掉
    // （收不到 run.ended）的，照实说完成
    const status: HistoryEntry['status'] = live ? 'running'
      : s.pending > 0 ? 'interrupted'
      : s.errors || fail ? 'failed' : 'done';
    const parent = r.kind === 'request' && r.parent_run_id ? byId.get(r.parent_run_id) : undefined;
    entries.push({
      batchKey: batchKeyOf(r),
      runId: r.run_id,
      kind: r.kind === 'request' ? 'request' : 'process',
      program: programName(parent ?? r),
      trigger: r.trigger,
      task: cleanTask(tasks.get(r.run_id)),
      startedAt: s.firstAt ?? r.started_at,
      endedAt: s.lastAt ?? r.ended_at,
      status,
      llm: s.llm,
      tool: s.tool,
      tokens: s.tokensIn + s.tokensOut,
      errors: s.errors,
      failing: fail,
      models: (s.models ?? '').split(',').filter(Boolean),
      replayOf: r.replay_of,
      // 子进程连同子进程的子进程一起列（npm test 本身没调用，干活的是它拉起的脚本）
      children: descendants(r.run_id).map((k) => ({ runId: k.run_id, program: programName(k), calls: own(k.run_id) })),
    });
  }

  const q = input.q?.trim().toLowerCase();
  const hit = (e: HistoryEntry) => !q || [e.task, e.program, e.trigger, e.runId, ...e.models]
    .some((x) => x && x.toLowerCase().includes(q));
  const shown = entries.filter(hit).sort((a, b) => b.startedAt - a.startedAt).slice(0, input.limit ?? 300);
  return { batches: toBatches(shown, byId), entries: shown, hiddenEmpty };

  /** 这一条属于哪一批（session 批要按时间再切，先只给目录） */
  function batchKeyOf(r: HistoryRun): string {
    const proc = r.kind === 'request' && r.parent_run_id ? byId.get(r.parent_run_id) : undefined;
    const g = r.group_id ?? proc?.group_id ?? null;
    // 显式的组名不是任何一个运行的 id（缺省时组就是进程自己）
    if (g && !byId.has(g)) return `group:${g}`;
    if (proc) return `service:${proc.run_id}`;
    return `session:${r.cwd ?? ''}`;
  }
}

function toBatches(entries: HistoryEntry[], byId: Map<string, HistoryRun>): HistoryBatch[] {
  const batches: HistoryBatch[] = [];
  const open = new Map<string, HistoryBatch>();
  // 从旧到新走：session 批按「和这一批最早那次相隔不到 10 分钟」往前接
  for (const e of [...entries].sort((a, b) => a.startedAt - b.startedAt)) {
    let b = open.get(e.batchKey);
    if (b && e.batchKey.startsWith('session:') && e.startedAt - (b.endedAt ?? b.startedAt) > SESSION_GAP_MS) b = undefined;
    if (!b) {
      const [kind, ...rest] = e.batchKey.split(':');
      const key = rest.join(':');
      const proc = kind === 'service' ? byId.get(key) : undefined;
      b = {
        id: `${e.batchKey}@${e.startedAt}`,
        kind: kind as HistoryBatch['kind'],
        title: kind === 'group' ? key : proc ? programName(proc) : e.program,
        scope: kind === 'service' ? key : kind === 'group' ? key : null,
        startedAt: proc?.started_at ?? e.startedAt,
        endedAt: null,
        status: 'done',
        llm: 0, tool: 0, tokens: 0, bad: 0,
        entries: [],
      };
      open.set(e.batchKey, b);
      batches.push(b);
    }
    b.entries.push(e);
    b.endedAt = Math.max(b.endedAt ?? 0, e.endedAt ?? e.startedAt);
    b.llm += e.llm;
    b.tool += e.tool;
    b.tokens += e.tokens;
    b.bad += e.errors + e.failing;
  }
  const rank = { running: 3, interrupted: 2, failed: 1, done: 0 } as const;
  for (const b of batches) {
    b.entries.sort((x, y) => y.startedAt - x.startedAt);
    // 一批里程序都一样就用程序名，不一样就说「目录 · N 个程序」
    if (b.kind === 'session') {
      const progs = new Set(b.entries.map((e) => e.program));
      if (progs.size > 1) {
        const dir = b.entries[0].program.split(' · ')[1] ?? '';
        b.title = `${dir || '同一目录'} · ${progs.size} 个程序`;
      }
    }
    b.status = b.entries.reduce<HistoryEntry['status']>((s, e) => (rank[e.status] > rank[s] ? e.status : s), 'done');
    if (b.status === 'done' && b.bad) b.status = 'failed';
  }
  return batches.sort((a, b) => (b.entries[0]?.startedAt ?? 0) - (a.entries[0]?.startedAt ?? 0));
}
