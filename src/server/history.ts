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

export type History = {
  entries: HistoryEntry[];
  /** 没列出来的：一次模型都没调过的运行个数 */
  hiddenEmpty: number;
};

const EMPTY: RunStats = { llm: 0, tool: 0, tokensIn: 0, tokensOut: 0, errors: 0, pending: 0, firstAt: null, lastAt: null, models: null };

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
  if (!a0) return dir || r.run_id;
  return `${a0}${a1}${dir ? ` · ${dir}` : ''}`;
}

/**
 * 任务原文的清理：agent 框架常把运行时上下文直接拼在用户消息后面（dsh 是「…有没有bugCurrent runtime context.」，
 * 连换行都没有），列表里只要人写的那一句。
 */
const INJECTED = /(Current runtime context|<system-reminder>|<environment_details>|<env>|<context>|<user-context>)/;

export function cleanTask(text: string | null | undefined, max = 140): string | null {
  if (!text) return null;
  let t = String(text);
  const m = INJECTED.exec(t);
  if (m && m.index > 0) t = t.slice(0, m.index);
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
    const live = procAlive && (s.pending > 0 || (s.lastAt != null && input.now - s.lastAt < 15_000) ||
      (r.kind !== 'request' && r.ended_at == null));
    const fail = failing.get(r.run_id) ?? 0;
    // 「中断」只算进程没了的时候还有调用没回来的 —— 一轮对话早就跑完、只是后来进程被关掉
    // （收不到 run.ended）的，照实说完成
    const status: HistoryEntry['status'] = live ? 'running'
      : s.pending > 0 ? 'interrupted'
      : s.errors || fail ? 'failed' : 'done';
    const parent = r.kind === 'request' && r.parent_run_id ? byId.get(r.parent_run_id) : undefined;
    entries.push({
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
  return {
    entries: entries.filter(hit).sort((a, b) => b.startedAt - a.startedAt).slice(0, input.limit ?? 300),
    hiddenEmpty,
  };
}
