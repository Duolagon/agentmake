// 项目管理：导入一个工程目录，然后在页面上直接把它跑起来。
//
// 为什么需要：在这之前这个工具是**被动**的 —— 你得先去终端敲一长串
// `NODE_OPTIONS="--import /abs/path/register.ts" node server.mjs`，跑起来页面才有东西。
// 对第一次用的人，这条命令本身就是最大的门槛：路径要拼对、入口要知道是哪个文件、
// Python 还要换成另一套写法。把这一步搬进页面，导入目录 → 认出入口 → 点启动。
//
// ⚠️ 这里会 spawn 用户给的命令。前提是：服务端只监听 127.0.0.1，命令是用户自己
// 在自己机器上填的，和他在终端里敲没有区别。不要把这个服务暴露到网络上。

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type Project = {
  id: string;
  name: string;
  dir: string;
  /** node | python | unknown —— 决定注入哪套 harness 环境变量 */
  kind: string;
  /** 实际执行的命令，用户可改。默认由探测得出 */
  cmd: string;
  /**
   * 触发命令（可选）。
   *
   * agent 分两类：一次性脚本，点▶就跑完了；常驻服务，点▶只是把它 boot 起来，
   * 还得有人去戳它才会真的干活。第二类在这之前是个死胡同 —— 页面上说
   * 「已经跑起来了，等它调模型」，却没有任何办法让它动。
   */
  trigger?: string;
  createdAt: number;
};

export type ProcState = {
  running: boolean;
  /** 从输出里认出来的本地地址 —— 服务型 agent 的入口，页面上做成可点的链接 */
  url: string | null;
  pid: number | null;
  startedAt: number | null;
  exitCode: number | null;
  /** 最近的输出行，页面上要看得到 —— 启动了却看不见输出等于没启动 */
  log: { t: number; s: 'out' | 'err'; line: string }[];
};

const MAX_LOG = 400;

const procs = new Map<string, ChildProcess>();
const states = new Map<string, ProcState>();

export function stateOf(id: string): ProcState {
  let s = states.get(id);
  if (!s) {
    s = { running: false, pid: null, startedAt: null, exitCode: null, url: null, log: [] };
    states.set(id, s);
  }
  return s;
}

// ── 目录浏览 ───────────────────────────────────────────────
//
// 浏览器的 <input type="directory"> 出于安全考虑拿不到真实绝对路径，
// 而我们恰恰需要绝对路径才能 cd 进去跑。所以在服务端做一个目录浏览器。

export async function listDir(target?: string): Promise<{
  path: string;
  parent: string | null;
  dirs: { name: string; path: string; hint: string }[];
}> {
  const dir = target && target !== '~' ? path.resolve(target) : os.homedir();
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    // 隐藏目录和依赖目录只会淹没列表
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '__pycache__') continue;
    const full = path.join(dir, e.name);
    dirs.push({ name: e.name, path: full, hint: await quickHint(full) });
  }
  dirs.sort((a, b) => (b.hint ? 1 : 0) - (a.hint ? 1 : 0) || a.name.localeCompare(b.name));

  const parent = path.dirname(dir);
  return { path: dir, parent: parent === dir ? null : parent, dirs };
}

/** 目录列表里直接标出「这个像是个项目」，省得一层层点进去试 */
async function quickHint(dir: string): Promise<string> {
  const has = async (f: string) => !!(await stat(path.join(dir, f)).catch(() => null));
  if (await has('package.json')) return 'Node 项目';
  if ((await has('pyproject.toml')) || (await has('requirements.txt'))) return 'Python 项目';
  return '';
}

// ── 探测入口 ───────────────────────────────────────────────

const NODE_ENTRIES = [
  'server.mjs', 'server.js', 'index.mjs', 'index.js', 'main.mjs', 'main.js', 'app.mjs', 'app.js',
  'src/index.mjs', 'src/index.js', 'src/main.mjs', 'src/main.js', 'src/server.mjs',
];
const PY_ENTRIES = ['main.py', 'app.py', 'run.py', 'agent.py', 'src/main.py', '__main__.py'];

export async function detect(dir: string): Promise<{ kind: string; cmd: string; note: string }> {
  const exists = async (f: string) => !!(await stat(path.join(dir, f)).catch(() => null));

  if (await exists('package.json')) {
    // package.json 写坏了不该让导入整个失败（以前直接 500）—— 当它不存在，继续按入口文件找
    let pkg: { main?: string; scripts?: { start?: string } } = {};
    let pkgBad = false;
    try {
      pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}')) ?? {};
    } catch {
      pkgBad = true;
    }
    if (pkgBad) {
      for (const e of NODE_ENTRIES) {
        if (await exists(e)) return { kind: 'node', cmd: `node ${e}`, note: `找到入口 ${e}（package.json 不是合法的 JSON，已忽略）` };
      }
      return { kind: 'node', cmd: 'node .', note: 'package.json 不是合法的 JSON，没认出入口，请自己改命令' };
    }
    for (const e of NODE_ENTRIES) {
      if (await exists(e)) return { kind: 'node', cmd: `node ${e}`, note: `找到入口 ${e}` };
    }
    if (pkg.main && (await exists(pkg.main))) {
      return { kind: 'node', cmd: `node ${pkg.main}`, note: `用 package.json 的 main：${pkg.main}` };
    }
    if (pkg.scripts?.start) {
      // npm 本身也是个 node 程序，会被 --import 一起插桩，多出一次没意义的「运行」。
      // 所以只在找不到入口文件时才退到这里，并且明说。
      return {
        kind: 'node',
        cmd: 'npm start',
        note: '没找到入口文件，退到 npm start（npm 自己也会被记一次，可忽略）',
      };
    }
    return { kind: 'node', cmd: 'node .', note: '没认出入口，请自己改命令' };
  }

  for (const e of PY_ENTRIES) {
    if (await exists(e)) {
      // -m agentmake 才能给**入口脚本**里的循环插桩（python foo.py 不走 importlib）
      return { kind: 'python', cmd: `python3 -m agentmake ${e}`, note: `找到入口 ${e}` };
    }
  }
  if ((await exists('pyproject.toml')) || (await exists('requirements.txt'))) {
    return { kind: 'python', cmd: 'python3 -m agentmake main.py', note: '没认出入口，请自己改命令' };
  }

  return { kind: 'unknown', cmd: '', note: '没认出这是什么项目，请自己填启动命令' };
}

// ── 启动 / 停止 ────────────────────────────────────────────

export function start(
  p: Project,
  env: { harnessPath: string; pyHarnessPath: string; url: string; replayFrom?: string | null },
  onLog: (id: string, entry: { t: number; s: 'out' | 'err'; line: string }) => void,
  onExit: (id: string, code: number | null) => void,
): { ok: boolean; error?: string } {
  if (procs.has(p.id)) return { ok: false, error: '已经在跑了' };
  if (!p.cmd.trim()) return { ok: false, error: '还没填启动命令' };

  // 导入的项目是用户亲手点 ▶ 跑的：带上项目标记，服务端照记（没选的进程不记，见 agents.ts）
  const extra: Record<string, string> = { AGENTMAKE_URL: env.url, AGENTMAKE_WATCH: `project:${p.id}` };
  if (p.kind === 'python') {
    // 保留用户原有的 PYTHONPATH，别把人家的依赖路径挤掉
    extra.PYTHONPATH = process.env.PYTHONPATH
      ? `${env.pyHarnessPath}${path.delimiter}${process.env.PYTHONPATH}`
      : env.pyHarnessPath;
  } else {
    extra.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ''} --import ${env.harnessPath}`.trim();
  }
  if (env.replayFrom) extra.AGENTMAKE_REPLAY = env.replayFrom;

  const st = stateOf(p.id);
  st.log = [];
  st.exitCode = null;
  st.url = null;

  // 目录不在了（项目被移走 / 删了）—— 直接说清楚，不要变成一个「在跑」的空壳
  if (!existsSync(p.dir)) return { ok: false, error: `项目目录不存在：${p.dir}` };

  let child: ChildProcess;
  try {
    // 走 shell：用户填的是一条命令行（可能带管道、环境变量、npm run），
    // 拆成 argv 反而会和他在终端里的写法对不上
    child = spawn(p.cmd, {
      cwd: p.dir,
      env: { ...process.env, ...extra },
      shell: true,
      // 自成进程组，停止时才能连同 shell 的子进程一起杀掉。
      // 不这么做的话，`npm start` 停下来了，它底下那个 node 还在跑、还占着端口。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  procs.set(p.id, child);
  st.running = true;
  st.pid = child.pid ?? null;
  st.startedAt = Date.now();

  // 服务型 agent 启动时几乎都会打一行 http://127.0.0.1:PORT。
  // 把它认出来做成可点的链接，用户就不用去猜「它到底在哪个端口」。
  const URL_RE = /https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?(?:\/\S*)?/;

  const pump = (s: 'out' | 'err') => (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      if (!st.url) {
        const m = URL_RE.exec(line);
        if (m) st.url = m[0].replace('0.0.0.0', '127.0.0.1');
      }
      const entry = { t: Date.now(), s, line };
      st.log.push(entry);
      if (st.log.length > MAX_LOG) st.log.shift();
      onLog(p.id, entry);
    }
  };
  child.stdout?.on('data', pump('out'));
  child.stderr?.on('data', pump('err'));

  // 收尾只做一次：spawn 失败（目录不存在、shell 起不来）时只来 error 不来 exit，
  // 以前只在 exit 里清状态，于是界面一直显示「运行中」，再点启动还被拒绝
  let ended = false;
  const finish = (code: number | null) => {
    if (ended) return;
    ended = true;
    if (procs.get(p.id) === child) procs.delete(p.id);
    st.running = false;
    st.pid = null;
    st.exitCode = code;
    onExit(p.id, code);
  };
  child.on('exit', (code) => finish(code));
  child.on('error', (e) => {
    const entry = { t: Date.now(), s: 'err' as const, line: `启动失败：${e.message}` };
    st.log.push(entry);
    onLog(p.id, entry);
    finish(null);
  });

  return { ok: true };
}

/**
 * 跑一次触发命令。
 *
 * 和 start 的区别：这个不进 procs（不算「项目在跑」），输出照样进同一份日志 ——
 * 用户点的是「让它干活」，不该在界面上变出第二个进程概念。
 */
export function trigger(
  p: Project,
  onLog: (id: string, entry: { t: number; s: 'out' | 'err'; line: string }) => void,
): { ok: boolean; error?: string } {
  if (!p.trigger?.trim()) return { ok: false, error: '这个项目没有设触发命令' };
  const st = stateOf(p.id);

  const child = spawn(p.trigger, {
    cwd: p.dir,
    env: { ...process.env, AGENTMAKE_URL: process.env.AGENTMAKE_URL ?? '' },
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const pump = (s: 'out' | 'err') => (buf: Buffer) => {
    for (const line of buf.toString('utf8').split(/\r?\n/)) {
      if (!line) continue;
      const entry = { t: Date.now(), s, line };
      st.log.push(entry);
      if (st.log.length > MAX_LOG) st.log.shift();
      onLog(p.id, entry);
    }
  };
  child.stdout?.on('data', pump('out'));
  child.stderr?.on('data', pump('err'));
  child.on('error', (e) => pump('err')(Buffer.from(`触发失败：${e.message}`)));
  return { ok: true };
}

export function stop(id: string): boolean {
  const child = procs.get(id);
  if (!child) return false;
  // 走的是 shell，真正的进程是 shell 的子进程 —— 杀进程组才不会留下孤儿
  try {
    if (child.pid) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  // 赖着不走的给一刀
  setTimeout(() => {
    if (procs.has(id)) {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 3000).unref?.();
  return true;
}

export function stopAll(): void {
  for (const id of [...procs.keys()]) stop(id);
}
