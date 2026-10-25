// 本机正在运行的 agent：扫出来、认出是什么、能怎么接 —— 选了才监控。
//
// 为什么要扫：以前是被动监视器，带着探针的进程一跑就全记下来，Codex 也是服务一起就自动读。
// 用户的诉求是反过来的：先看本机在跑哪些 agent，挑一个，只监控它。
//
// 认法（不靠网络连接 —— 走代理时看到的目标地址全是代理的，agent 不调模型时也根本没有连接）：
//   · Codex：它的原生程序（CodexCLI.app 里的 codex），有会话记录可读
//   · Node / Python：已知的 agent 程序名（dsh、aider…），或者它所在项目的依赖里有模型 SDK
//   · Claude Code 这类打包成原生程序、又没接会话记录的：列出来，说明暂时接不了
// 接法：
//   · Node 没带探针：不重启，让它打开调试口（SIGUSR1），经调试协议把探针装进去，装完马上关掉调试口
//   · Python 没带探针：只能重启 —— 用它原来的命令、目录、环境变量重新起，带上探针
//   · 已经带着探针的（手动在终端里起的）：记下它的 pid 就行
//   · Codex：开始读 ~/.codex/sessions
// 没选的进程就算带着探针连上来，事件也不落库（见 accepts）。

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const sh = async (cmd: string, args: string[]) =>
  (await run(cmd, args, { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 32 * 1024 * 1024 }).catch((e) => ({ stdout: String(e.stdout ?? '') }))).stdout;

export type Proc = { pid: number; ppid: number; startedAt: number; args: string };

export type AgentKind = 'node' | 'python' | 'codex' | 'native';
export type AgentAction = 'attach' | 'watch' | 'restart' | 'codex' | null;

export type Candidate = {
  pid: number;
  kind: AgentKind;
  /** 列表里的名字：dsh web、Codex、my_agent.py */
  name: string;
  /** 完整命令行（截短），认错了能看出来 */
  detail: string;
  cwd: string | null;
  startedAt: number;
  /** 为什么认为它是 agent */
  why: string;
  /** 是 agent 的把握：false 的放进「其它 Node / Python 进程」 */
  agentLike: boolean;
  /** 已经带着探针（手动加了 NODE_OPTIONS / PYTHONPATH） */
  probe: boolean;
  /** 正在监控它的那条记录 */
  watchId: string | null;
  /** 点「监控」会做什么 */
  action: AgentAction;
  note: string;
};

/** 认得的 agent 程序名 —— 依赖里不一定看得出来（dsh 的依赖全是自家包） */
const KNOWN = /^(dsh|aider|gemini|opencode|goose|crush|qwen|cline|openhands|cursor-agent|amp|kimi|plandex|gptme|interpreter|swe-agent|mini-swe-agent|codex|claude)$/;
/** 依赖里出现这些，就当它会调模型 */
const NODE_LLM = /^(openai|ai|ollama|groq-sdk|cohere-ai|deepseek.*|@anthropic-ai\/.+|@ai-sdk\/.+|@langchain\/.+|langchain|@google\/(genai|generative-ai)|@mistralai\/.+|@openai\/.+|@modelcontextprotocol\/sdk|@deepseek-ai\/.+)$/;
const PY_LLM = /^(openai|anthropic|langchain[\w-]*|litellm|google-genai|google-generativeai|mistralai|ollama|groq|dashscope|zhipuai|llama-index[\w-]*|crewai|pyautogen|autogen[\w-]*|pydantic-ai|smolagents|openai-agents|deepseek)$/i;

/** ps 的输出 → 进程表。lstart 是固定格式「Sun Oct 25 03:12:38 2026」，前 5 段 */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/.exec(line);
    if (!m) continue;
    const [wd, mon, day, time, year] = m[3].split(/\s+/);
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), startedAt: Date.parse(`${wd} ${mon} ${day} ${year} ${time}`), args: m[4] });
  }
  return out;
}

export async function listProcs(): Promise<Proc[]> {
  return parsePs(await sh('ps', ['-axo', 'pid=,ppid=,lstart=,args=']));
}

type Ctx = {
  /** AgentMake 自己的目录：它自己的进程（服务、MCP）不算 */
  selfDir: string;
  selfPid: number;
  realpath: (p: string) => string;
  readText: (p: string) => string | null;
  exists: (p: string) => boolean;
};

const base = (p: string) => p.split('/').pop() ?? p;
/** 带值的启动参数：跳过它们才找得到脚本 */
const NODE_VALUE_FLAGS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C', '--input-type', '--title']);

/** 一个进程是什么、像不像 agent。不是 Node / Python / Codex 的返回 null */
export function classify(p: Proc, cwd: string | null, ctx: Ctx): Omit<Candidate, 'probe' | 'watchId' | 'action' | 'note'> | null {
  if (p.pid === ctx.selfPid) return null;
  const tok = p.args.split(/\s+/).filter(Boolean);
  const exe = tok[0] ?? '';
  const exeName = base(exe);
  const common = { pid: p.pid, cwd, startedAt: p.startedAt, detail: p.args.length > 160 ? `${p.args.slice(0, 160)}…` : p.args };

  // Codex：桌面版的 app-server，或者命令行版的 codex（它拉起的辅助进程不算）
  if (exeName === 'codex' && (/\bapp-server\b/.test(p.args) || !/\.app\/Contents\//.test(exe))) {
    if (/\b(exec-server|mcp-server)\b/.test(p.args)) return null;
    return { ...common, kind: 'codex', name: /\.app\/Contents\//.test(exe) ? 'Codex（桌面版）' : 'Codex', why: '有会话记录可读', agentLike: true };
  }
  // 应用自带的运行时（Codex / Claude 桌面版里的 node）—— 是应用的零件，不是用户的 agent
  // （Homebrew / python.org 的 Python 本身就装在 Python.framework/…/Python.app 里，那个不算）
  if (/\.app\/Contents\/|\/Library\/Application Support\//.test(exe) && !/\/Python\.framework\//.test(exe)) return null;

  if (exeName === 'claude' || exeName === 'bun') {
    return { ...common, kind: 'native', name: exeName === 'claude' ? 'Claude Code' : `bun ${base(tok[1] ?? '')}`.trim(), why: exeName === 'claude' ? '已知 agent' : 'Bun 程序', agentLike: exeName === 'claude' };
  }

  if (/^node(js)?$/.test(exeName)) {
    let i = 1;
    while (i < tok.length && tok[i].startsWith('-')) {
      if (tok[i] === '-e' || tok[i] === '--eval' || tok[i] === '-p') return null; // 一段内联代码，不是 agent
      i += NODE_VALUE_FLAGS.has(tok[i]) ? 2 : 1;
    }
    const script = tok[i];
    if (!script) return null;
    const real = safe(() => ctx.realpath(script), script);
    if (real.startsWith(ctx.selfDir) || script.startsWith(ctx.selfDir)) return null;
    const pkgDir = findUp(path.dirname(real), 'package.json', ctx);
    const pkg = pkgDir ? safe(() => JSON.parse(ctx.readText(path.join(pkgDir, 'package.json')) ?? '{}'), {}) : {};
    // 名字：全局装的命令（/opt/homebrew/bin/dsh）用命令名；npx / node_modules 里的用包名；其余用脚本名
    const fromBin = /\/bin\/[^/]+$/.test(script) && !/\.[cm]?[jt]s$/.test(script) ? base(script) : null;
    const name = fromBin ?? (real.includes('/node_modules/') ? String(pkg.name ?? base(real)) : base(script).replace(/\.[cm]?[jt]s$/, ''));
    const sub = tok[i + 1] && !tok[i + 1].startsWith('-') && !tok[i + 1].includes('/') ? ` ${tok[i + 1]}` : '';
    const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.devDependencies ?? {}) });
    const cwdPkg = !pkgDir && cwd ? findUp(cwd, 'package.json', ctx) : null;
    if (cwdPkg) deps.push(...Object.keys(safe(() => JSON.parse(ctx.readText(path.join(cwdPkg, 'package.json')) ?? '{}').dependencies ?? {}, {})));
    const llm = deps.find((d) => NODE_LLM.test(d));
    const known = KNOWN.test(base(name).replace(/^@[^/]+\//, '')) || KNOWN.test(String(pkg.name ?? '').replace(/^@[^/]+\//, ''));
    return { ...common, kind: 'node', name: `${base(name)}${sub}`, why: known ? '已知 agent' : llm ? `依赖里有 ${llm}` : 'Node 程序', agentLike: known || !!llm };
  }

  if (/^python(\d(\.\d+)?)?$/i.test(exeName)) {
    let i = 1;
    let mod: string | null = null;
    while (i < tok.length && tok[i].startsWith('-')) {
      if (tok[i] === '-c') return null;
      if (tok[i] === '-m') { mod = tok[i + 1] ?? null; break; }
      i += ['-W', '-X', '-Q'].includes(tok[i]) ? 2 : 1;
    }
    const script = mod ? null : tok[i];
    if (!mod && !script) return null; // 交互式解释器
    if ((script ?? '').startsWith(ctx.selfDir)) return null;
    const name = mod ?? base(script!);
    const dirs = [script ? path.dirname(safe(() => ctx.realpath(script), script)) : null, cwd].filter(Boolean) as string[];
    let llm: string | null = null;
    for (const d of dirs) {
      for (const f of ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile']) {
        const at = findUp(d, f, ctx);
        const text = at ? ctx.readText(path.join(at, f)) : null;
        const hit = text?.match(/[\w.-]+/g)?.find((w) => PY_LLM.test(w));
        if (hit) { llm = hit; break; }
      }
      if (llm) break;
    }
    const known = KNOWN.test(base(name).replace(/\.py$/, ''));
    return { ...common, kind: 'python', name, why: known ? '已知 agent' : llm ? `依赖里有 ${llm}` : 'Python 程序', agentLike: known || !!llm };
  }

  // 命令行版的已知 agent（全局装的脚本被解释器拉起时上面已经认过了）
  if (KNOWN.test(exeName) && !exe.includes('.app/')) {
    return { ...common, kind: 'native', name: exeName, why: '已知 agent', agentLike: true };
  }
  return null;
}

function findUp(dir: string, file: string, ctx: Ctx): string | null {
  let d = dir;
  for (let n = 0; n < 12 && d && d !== '/'; n++) {
    if (ctx.exists(path.join(d, file))) return d;
    d = path.dirname(d);
  }
  return null;
}

function safe<T>(f: () => T, fallback: T): T {
  try {
    return f();
  } catch {
    return fallback;
  }
}

export const realCtx = (selfDir: string): Ctx => ({
  selfDir,
  selfPid: process.pid,
  realpath: (p) => realpathSync(p),
  readText: (p) => {
    try {
      return statSync(p).size < 2_000_000 ? readFileSync(p, 'utf8') : null;
    } catch {
      return null;
    }
  },
  exists: (p) => existsSync(p),
});

/** 一批进程的工作目录（lsof 一次查完） */
export async function cwdsOf(pids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!pids.length) return out;
  const text = await sh('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', pids.join(',')]);
  let pid = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/**
 * 进程的环境变量（只给同一用户的进程；macOS 的 ps eww 把它们接在命令行后面）。
 * 只用来判断有没有带探针、以及重启时原样带上 —— 不往页面上送。
 */
export async function envOf(pid: number, args: string): Promise<Record<string, string>> {
  const line = (await sh('ps', ['eww', '-o', 'command=', '-p', String(pid)])).replace(/\n$/, '');
  return parseEnvTail(line, args);
}

export function parseEnvTail(line: string, args: string): Record<string, string> {
  const tail = line.startsWith(args) ? line.slice(args.length) : line.slice(line.indexOf(' ') + 1);
  const env: Record<string, string> = {};
  // 值里可以有空格：按「空格 + 变量名=」切
  for (const part of tail.trim().split(/ (?=[A-Za-z_][A-Za-z0-9_]*=)/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(part.slice(0, eq))) env[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return env;
}

export type HarnessPaths = { node: string; python: string; url: string };

/** 这个进程已经带着探针了吗（手动加了 NODE_OPTIONS / PYTHONPATH） */
export function hasProbe(env: Record<string, string>, h: HarnessPaths): boolean {
  return (env.NODE_OPTIONS ?? '').includes(h.node) || (env.PYTHONPATH ?? '').split(path.delimiter).includes(h.python);
}

/**
 * 扫一遍：本机正在跑的 agent，每个标上现在的状态和「点监控会做什么」。
 * Codex 桌面版一开就是十几个进程，只列一条。
 */
export async function scan(opts: { ctx: Ctx; harness: HarnessPaths; watches: Watch[]; codexReadable: boolean }): Promise<Candidate[]> {
  const procs = await listProcs();
  const pre = procs.map((p) => ({ p, c: classify(p, null, opts.ctx) })).filter((x) => x.c);
  const cwds = await cwdsOf(pre.map((x) => x.p.pid));
  const active = opts.watches.filter((w) => w.ended_at == null);
  const out: Candidate[] = [];
  let codexSeen = false;
  for (const { p } of pre) {
    // 有了工作目录再认一次（依赖要从工作目录找）
    const c = classify(p, cwds.get(p.pid) ?? null, opts.ctx)!;
    if (c.kind === 'codex') {
      if (codexSeen) continue;
      codexSeen = true;
      const w = active.find((x) => x.kind === 'codex');
      out.push({ ...c, probe: false, watchId: w?.id ?? null, action: w ? null : opts.codexReadable ? 'codex' : null,
        note: opts.codexReadable ? '读它的会话记录（~/.codex/sessions），只能看，不能打断点' : '找不到 ~/.codex/sessions，读不了' });
      continue;
    }
    const w = active.find((x) => x.kind === 'pid' && x.pid === p.pid && (x.started_at == null || Math.abs(x.started_at - p.startedAt) < 2000));
    if (c.kind === 'native') {
      out.push({ ...c, probe: false, watchId: null, action: null,
        note: c.name === 'Claude Code' ? '原生程序，挂不上探针；读它会话记录的接入还没做' : '不是 Node / Python，挂不上探针' });
      continue;
    }
    const env = await envOf(p.pid, p.args);
    const probe = hasProbe(env, opts.harness);
    const action: AgentAction = w ? null : probe ? 'watch' : c.kind === 'node' ? 'attach' : 'restart';
    out.push({ ...c, probe, watchId: w?.id ?? null, action,
      note: w ? '' : probe ? '已经带着探针，选上就开始记'
        : c.kind === 'node' ? '不用重启，直接挂上（只记挂上之后的调用）'
        : '要重启才能挂上：用它原来的命令和环境重新起，输出改写到日志文件' });
  }
  // 监控中的排前面，然后是像 agent 的，再按启动时间新的在前
  return out.sort((a, b) => Number(!!b.watchId) - Number(!!a.watchId) || Number(b.agentLike) - Number(a.agentLike) || b.startedAt - a.startedAt);
}

// ── 把探针挂到正在跑的 Node 进程上 ──────────────────────────

const INSPECT = 'http://127.0.0.1:9229';

/**
 * 不重启，给正在跑的 Node 进程装上探针。
 *
 * SIGUSR1 让 Node 打开调试口（固定 127.0.0.1:9229），经调试协议在它里面执行：设好上报地址和监控标记，
 * require 探针（Node 22.12+ 能 require ES 模块、23.6+ 能直接跑 .ts），装上，然后立刻关掉调试口 ——
 * 调试口开着等于本机任何程序都能在它里面执行代码。
 * 装上之后只记得到之后的调用；循环插桩要在启动时装，挂上去的没有。
 */
export async function attachNode(pid: number, opts: { intercept: string; url: string; watch: string; timeoutMs?: number }): Promise<{ ok: true } | { ok: false; error: string }> {
  // 9229 已经有别的调试器在听：发信号也开不了，还可能连到别人身上
  if (await fetch(`${INSPECT}/json/list`, { signal: AbortSignal.timeout(400) }).then(() => true, () => false)) {
    return { ok: false, error: '调试端口 9229 已经被别的调试器占着，挂不上。可以改用「重启并监控」' };
  }
  try {
    process.kill(pid, 'SIGUSR1');
  } catch (e) {
    return { ok: false, error: `发不了信号：${(e as Error).message}` };
  }
  let targets: { webSocketDebuggerUrl: string }[] | null = null;
  const until = Date.now() + (opts.timeoutMs ?? 4000);
  while (!targets && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 150));
    targets = await fetch(`${INSPECT}/json/list`, { signal: AbortSignal.timeout(400) }).then((r) => r.json(), () => null);
  }
  if (!targets?.length) return { ok: false, error: '它没有打开调试口（可能带了 --disable-sigusr1，或者不是 Node）。可以改用「重启并监控」' };

  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('连不上调试口'));
    });
    let id = 0;
    const call = (expression: string, wait = 5000) =>
      new Promise<{ value?: unknown; error?: string }>((res) => {
        const my = ++id;
        const t = setTimeout(() => res({ error: '调试口没有响应' }), wait);
        ws.addEventListener('message', function h(e) {
          const m = JSON.parse(String(e.data));
          if (m.id !== my) return;
          clearTimeout(t);
          ws.removeEventListener('message', h);
          const r = m.result;
          res(r?.exceptionDetails ? { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text } : { value: r?.result?.value });
        });
        ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });

    // 调试口是固定端口：确认连上的就是这个进程，不是恰好同时开了调试口的别人
    const who = await call('process.pid');
    if (who.value !== pid) return { ok: false, error: '调试口上不是这个进程，没有动它' };

    const code = `(() => {
      const env = process.env;
      env.AGENTMAKE_URL = ${JSON.stringify(opts.url)};
      env.AGENTMAKE_WATCH = ${JSON.stringify(opts.watch)};
      if (globalThis.__agentmakeAttached) return 'already';
      if (typeof process.getBuiltinModule !== 'function') throw new Error('Node ' + process.version + ' 太旧：需要 22.12 以上');
      const req = process.getBuiltinModule('node:module').createRequire(${JSON.stringify(opts.intercept)});
      req(${JSON.stringify(opts.intercept)}).install();
      globalThis.__agentmakeAttached = true;
      return 'ok';
    })()`;
    const r = await call(code);
    // 不管装没装上，调试口都要关掉
    // 关调试口会把我们这条连接一起断掉，回不了话 —— 不等它
    await call(`process.getBuiltinModule?.('node:inspector')?.close(), 'closed'`, 300);
    if (r.error) return { ok: false, error: `装探针失败：${r.error.split('\n')[0]}。可以改用「重启并监控」` };
    return { ok: true };
  } finally {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}

// ── 重启并带上探针（Python，或者挂不上的 Node） ─────────────────

/**
 * 用它原来的命令、目录、环境变量重新起一个，带上探针。
 * 先礼貌地 SIGTERM，等它退出；5 秒还不退就放弃，不强杀 —— 可能在等输入或在写东西。
 * 新进程的输出写到 .agentmake/logs/<监控 id>.log（原来那个终端已经不在它手上了）。
 */
export async function restartWithProbe(
  p: { pid: number; args: string; kind: AgentKind },
  opts: { harness: HarnessPaths; watch: string; logDir: string },
): Promise<{ ok: true; pid: number; log: string } | { ok: false; error: string }> {
  const cwd = (await cwdsOf([p.pid])).get(p.pid);
  if (!cwd) return { ok: false, error: '读不到它的工作目录，没有动它' };
  const env = await envOf(p.pid, p.args);
  if (!Object.keys(env).length) return { ok: false, error: '读不到它的环境变量（不是你的进程？），没有动它' };
  const argv = p.args.split(/\s+/).filter(Boolean);

  try {
    process.kill(p.pid, 'SIGTERM');
  } catch (e) {
    return { ok: false, error: `结束不了它：${(e as Error).message}` };
  }
  const until = Date.now() + 5000;
  while (Date.now() < until && alive(p.pid)) await new Promise((r) => setTimeout(r, 100));
  if (alive(p.pid)) return { ok: false, error: '发了结束信号，5 秒还没退出（可能在等输入），没有重启，也没有强杀' };

  const probe: Record<string, string> = { AGENTMAKE_URL: opts.harness.url, AGENTMAKE_WATCH: opts.watch };
  if (p.kind === 'python') probe.PYTHONPATH = [opts.harness.python, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
  else probe.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import ${opts.harness.node}`.trim();

  mkdirSync(opts.logDir, { recursive: true });
  const log = path.join(opts.logDir, `${opts.watch}.log`);
  const fd = openSync(log, 'a');
  try {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...env, ...probe }, detached: true, stdio: ['ignore', fd, fd] });
    child.unref();
    if (!child.pid) return { ok: false, error: '重新启动失败' };
    return { ok: true, pid: child.pid, log };
  } catch (e) {
    return { ok: false, error: `重新启动失败：${(e as Error).message}` };
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// ── 选了才记：事件来自谁、要不要记 ──────────────────────────

export type Watch = {
  id: string;
  kind: 'pid' | 'codex';
  pid: number | null;
  /** 进程启动时间：pid 会被复用，对不上就不是原来那个进程 */
  started_at: number | null;
  label: string;
  detail: string | null;
  cwd: string | null;
  opts: string | null;
  created_at: number;
  ended_at: number | null;
};

/**
 * 判断一个上报来源要不要记。
 *   · 带着监控标记（AGENTMAKE_WATCH，我们挂上 / 重启 / 导入的项目启动时设的，子进程会继承）
 *   · 或者它的 pid 在监控列表里，或者是监控中进程的子孙（dsh 跑 npm test 拉起的 node）
 * AGENTMAKE_RECORD_ALL=1 时什么都记（以前的被动监视；测试用它）。
 */
export class Acceptor {
  private procs: Map<number, Proc> = new Map();
  private procsAt = 0;
  private cache = new Map<string, { ok: boolean; at: number }>();

  private watches: () => Watch[];
  private recordAll: boolean;
  private table: () => Promise<Proc[]>;

  constructor(watches: () => Watch[], recordAll = process.env.AGENTMAKE_RECORD_ALL === '1', table: () => Promise<Proc[]> = listProcs) {
    this.watches = watches;
    this.recordAll = recordAll;
    this.table = table;
  }

  /** 监控列表变了：之前的判断作废 */
  reset(): void {
    this.cache.clear();
    this.procsAt = 0;
  }

  async accepts(src: { pid: number | null; watch: string | null }): Promise<boolean> {
    if (this.recordAll) return true;
    const active = this.watches().filter((w) => w.ended_at == null);
    if (src.watch && (src.watch === 'manual' || src.watch.startsWith('project:') || active.some((w) => w.id === src.watch))) return true;
    if (src.pid == null) return false;
    const key = `${src.pid}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 5000) return hit.ok;

    const pids = active.filter((w) => w.kind === 'pid' && w.pid != null);
    let ok = false;
    if (pids.length) {
      if (Date.now() - this.procsAt > 3000 || !this.procs.has(src.pid)) {
        this.procs = new Map((await this.table()).map((p) => [p.pid, p]));
        this.procsAt = Date.now();
      }
      // 自己或者祖先在监控列表里（启动时间对得上，防 pid 复用）
      let cur = this.procs.get(src.pid);
      for (let n = 0; cur && n < 40 && !ok; n++) {
        const c = cur;
        ok = pids.some((w) => w.pid === c.pid && (w.started_at == null || Math.abs(w.started_at - c.startedAt) < 2000));
        cur = c.ppid > 1 ? this.procs.get(c.ppid) : undefined;
      }
    }
    this.cache.set(key, { ok, at: Date.now() });
    return ok;
  }
}

/** 老版本的探针不带来源：按 TCP 连接反查是哪个进程连过来的（lsof），每条连接只查一次 */
export async function pidOfPeer(remotePort: number): Promise<number | null> {
  const text = await sh('lsof', ['-nP', `-iTCP@127.0.0.1:${remotePort}`, '-sTCP:ESTABLISHED', '-Fp']);
  const pids = text.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1)));
  return pids.find((p) => p !== process.pid) ?? null;
}
