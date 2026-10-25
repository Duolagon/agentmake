// 子进程：探针随 NODE_OPTIONS / PYTHONPATH 传给被调试程序启动的每个子进程。
//
// 这是好事也是坏事。好事：agent 拉起的子 agent、worker 也看得见。坏事：像 dsh 这种
// 会用 bash 跑命令的 agent，它跑的 npm test、构建脚本、测试服务也全被观测，几十个
// 不相干的运行冲进列表，把真正要看的那一个淹掉。
//
// 两件事：
//   1. 默认继续传，但告诉子进程「谁拉起了你」（AGENTMAKE_SPAWNED_BY）。服务端据此把子进程
//      归到父运行的组里、在列表里缩进挂在父运行下面，不再各自顶到最上面。
//      在请求里拉起的子进程记到那次请求上（dsh 的某一轮对话），不是笼统的进程。
//   2. AGENTMAKE_CHILDREN=0：探针装好之后把自己从 NODE_OPTIONS / PYTHONPATH 里摘掉，
//      子进程干干净净，什么都不报。

import cp from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SPAWNED_BY = 'AGENTMAKE_SPAWNED_BY';

/** 这个进程是被谁拉起的（父进程的运行 id）。必须在 installChildren 改写环境变量之前读 */
export const spawnedBy = process.env[SPAWNED_BY] || undefined;

const REGISTER = fileURLToPath(new URL('./register.ts', import.meta.url));
const PY_HARNESS = path.resolve(path.dirname(REGISTER), '../pyharness');

/** 从 NODE_OPTIONS 里去掉我们的 --import（几种写法：空格 / 等号 / 引号 / file:// URL） */
export function stripNodeOptions(opts: string, register = REGISTER): string {
  const targets = [register, `file://${register}`].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(`--import(?:=|\\s+)(["']?)(?:${targets.join('|')})\\1`, 'g');
  return opts.replace(re, '').replace(/\s+/g, ' ').trim();
}

/** 从 PYTHONPATH 里去掉 Python 探针目录 */
export function stripPythonPath(pp: string, harness = PY_HARNESS): string {
  return pp.split(path.delimiter).filter((p) => p && path.resolve(p) !== harness).join(path.delimiter);
}

export function installChildren(processRunId: string, runIdNow: () => string): void {
  if (process.env.AGENTMAKE_CHILDREN === '0') {
    const no = stripNodeOptions(process.env.NODE_OPTIONS ?? '');
    if (no) process.env.NODE_OPTIONS = no;
    else delete process.env.NODE_OPTIONS;
    const pp = stripPythonPath(process.env.PYTHONPATH ?? '');
    if (pp) process.env.PYTHONPATH = pp;
    else delete process.env.PYTHONPATH;
    return;
  }

  // 显式传了 env 的 spawn 不读 process.env，所以光改它不够，同步的 spawnSync 也走不到下面的补丁 ——
  // 这两种情况至少还能记到进程级运行上
  process.env[SPAWNED_BY] = processRunId;

  // 异步的 spawn / exec / execFile / fork 最后都落到 ChildProcess.prototype.spawn，
  // 那时环境变量已经展开成 envPairs —— 在这里把「谁拉起的」换成当前所在的运行（请求级）
  const proto = cp.ChildProcess.prototype as unknown as { spawn: (o: { envPairs?: string[] }) => unknown };
  const orig = proto.spawn;
  proto.spawn = function (this: unknown, options: { envPairs?: string[] }) {
    try {
      if (Array.isArray(options?.envPairs)) {
        const rid = runIdNow(); // 只读：请求里还没调用过（没登记）就记到进程上，不为它新登记一个空运行
        options.envPairs = options.envPairs.filter((p) => !p.startsWith(`${SPAWNED_BY}=`));
        options.envPairs.push(`${SPAWNED_BY}=${rid}`);
      }
    } catch {
      /* 观测绝不能影响子进程能不能起来 */
    }
    return orig.call(this, options);
  };
}
