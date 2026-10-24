// 端到端跑法：起 mock-llm + debugger server，依次跑各个 e2e 套件，最后收摊。
//
// 之前各个套件都假设「服务端已经开着」，跑之前忘了起就是一串 ECONNREFUSED，
// 看起来像代码坏了。把编排收进来，`npm run test:e2e` 一条命令自洽。

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DB = path.join(ROOT, '.agentmake', 'e2e.db');

const SUITES = ['breakpoint.e2e.mjs', 'mcp.e2e.mjs', 'replay.e2e.mjs', 'loop.e2e.mjs', 'proxy.e2e.mjs', 'spec.e2e.mjs', 'python.e2e.mjs', 'toolcall.e2e.mjs', 'scores.e2e.mjs', 'requests.e2e.mjs', 'dataflow.e2e.mjs', 'clients.e2e.mjs', 'security.e2e.mjs'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

function start(script, env) {
  const p = spawn(process.execPath, [path.join(ROOT, script)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  children.push(p);
  return p;
}

async function isUp(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(800) });
    return true;
  } catch {
    return false;
  }
}

async function waitUp(url, timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      await fetch(url);
      return true;
    } catch {
      await sleep(150);
    }
  }
  return false;
}

function stopAll() {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

// 每次跑用独立的库，别把开发时攒下的运行混进断言
for (const suffix of ['', '-wal', '-shm']) {
  try { rmSync(DB + suffix); } catch { /* 本来就没有 */ }
}

// 端口已被占用时必须立刻停 —— 否则我们起的 server 静默 EADDRINUSE 退出，
// 测试全程打在别人那个进程上（跑着旧代码、用着别的库），结果完全不可信。
// 这个坑真的踩过：两条断言"失败"，实际是在跟一个残留的旧 server 说话。
for (const [port, what] of [[8799, 'mock-llm'], [8787, 'debugger server']]) {
  if (await isUp(`http://127.0.0.1:${port}/`)) {
    console.error(
      `端口 ${port} 已被占用（${what}）。先关掉它再跑：\n` +
      `  pkill -f 'src/server/index.ts'; pkill -f mock-llm`,
    );
    process.exit(1);
  }
}

start('test/mock-llm.ts', {});
start('src/server/index.ts', { AGENTMAKE_DB: DB });

if (!(await waitUp('http://127.0.0.1:8799/__count')) || !(await waitUp('http://127.0.0.1:8787/api/health'))) {
  console.error('mock 或 server 没起来');
  process.exit(1);
}

let failed = 0;
for (const s of SUITES) {
  console.log(`\n══════ ${s} ══════`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, s)], {
      env: { ...process.env, AGENTMAKE_DB: DB },
      stdio: 'inherit',
    });
    p.on('exit', resolve);
  });
  if (code !== 0) {
    failed++;
    console.error(`✗ ${s} 退出码 ${code}`);
  }
}

stopAll();
console.log(failed ? `\n${failed} 个套件失败` : '\n全部 e2e 套件通过');
process.exit(failed ? 1 : 0);
