// 本机 agent：扫出来认得对不对、没选的进程是不是真的不记。
// 进程表、文件系统都是假的，不依赖本机实际在跑什么。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { Acceptor, attachNode, classify, hasProbe, parseEnvTail, parsePs } from '../src/server/agents.ts';
import type { Proc, Watch } from '../src/server/agents.ts';

const FILES: Record<string, string> = {
  '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', dependencies: { '@deepseek-ai/cordis': '1' } }),
  '/work/bot/package.json': JSON.stringify({ name: 'bot', dependencies: { openai: '^5', express: '^4' } }),
  '/work/site/package.json': JSON.stringify({ name: 'site', dependencies: { express: '^4' } }),
  '/work/pyagent/requirements.txt': 'requests==2\nanthropic>=0.40\n',
};
const LINKS: Record<string, string> = { '/opt/homebrew/bin/dsh': '/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/bin.js' };
const ctx = {
  selfDir: '/home/me/agentmake',
  selfPid: 1,
  realpath: (p: string) => LINKS[p] ?? p,
  readText: (p: string) => FILES[p] ?? null,
  exists: (p: string) => p in FILES,
};
const proc = (pid: number, args: string): Proc => ({ pid, ppid: 1, startedAt: 1000, args });

test('ps 输出：pid / 父进程 / 启动时间 / 命令行', () => {
  const ps = parsePs('  19147 19133 Sun Oct 25 11:45:17 2026     node /opt/homebrew/bin/dsh web --port 3081\n    1     0 Sat Oct  3 18:54:54 2026     /sbin/launchd\n');
  assert.equal(ps.length, 2);
  assert.deepEqual([ps[0].pid, ps[0].ppid, ps[0].args], [19147, 19133, 'node /opt/homebrew/bin/dsh web --port 3081']);
  assert.equal(new Date(ps[0].startedAt).getHours(), 11);
  assert.equal(new Date(ps[1].startedAt).getDate(), 3, '单数日期前面是两个空格');
});

test('认 agent：已知程序名、依赖里有模型 SDK 的算；普通服务、应用自带的运行时、AgentMake 自己不算', () => {
  const dsh = classify(proc(10, 'node /opt/homebrew/bin/dsh web --port 3081'), '/work', ctx)!;
  assert.deepEqual([dsh.kind, dsh.name, dsh.agentLike, dsh.why], ['node', 'dsh web', true, '已知 agent']);

  const bot = classify(proc(11, 'node --import tsx /work/bot/index.mjs'), '/work/bot', ctx)!;
  assert.deepEqual([bot.name, bot.agentLike, bot.why], ['index', true, '依赖里有 openai']);

  const site = classify(proc(12, 'node /work/site/server.js'), '/work/site', ctx)!;
  assert.equal(site.agentLike, false, '只是个 Node 服务：放进「其它进程」');

  const py = classify(proc(13, '/opt/homebrew/Cellar/python@3.13/3.13.0/Frameworks/Python.framework/Versions/3.13/Resources/Python.app/Contents/MacOS/Python /work/pyagent/main.py'), '/work/pyagent', ctx)!;
  assert.deepEqual([py.kind, py.name, py.agentLike, py.why], ['python', 'main.py', true, '依赖里有 anthropic']);

  const codex = classify(proc(14, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c x=1 app-server --analytics'), null, ctx)!;
  assert.equal(codex.kind, 'codex');
  assert.equal(classify(proc(15, '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex exec-server --remote x'), null, ctx), null, 'Codex 的辅助进程不算');

  assert.equal(classify(proc(16, '/Users/me/Library/Application Support/Codex/runtime/bin/node /x/server.js'), null, ctx), null, '应用自带的 node');
  assert.equal(classify(proc(17, 'node /home/me/agentmake/src/server/index.ts'), null, ctx), null, 'AgentMake 自己');
  assert.equal(classify(proc(1, 'node /work/bot/index.mjs'), null, ctx), null, '自己的 pid');
  assert.equal(classify(proc(18, 'node -e "setInterval(()=>{},1000)"'), null, ctx), null, '一段内联代码');
  assert.equal(classify(proc(19, 'python3'), null, ctx), null, '交互式解释器');
  assert.equal(classify(proc(20, 'python3 -m aider --model x'), '/w', ctx)!.agentLike, true, 'python -m 已知 agent');
});

test('环境变量：按「空格 + 变量名=」切，值里可以有空格；认得出已经带着探针', () => {
  const args = 'node /opt/homebrew/bin/dsh web';
  const env = parseEnvTail(`${args} NODE_OPTIONS=--import /a/agentmake/src/harness/register.ts HOME=/Users/me TITLE=a b c`, args);
  assert.deepEqual(env, { NODE_OPTIONS: '--import /a/agentmake/src/harness/register.ts', HOME: '/Users/me', TITLE: 'a b c' });
  const h = { node: '/a/agentmake/src/harness/register.ts', python: '/a/agentmake/src/pyharness', url: '' };
  assert.ok(hasProbe(env, h));
  assert.ok(hasProbe({ PYTHONPATH: `/x:${h.python}` }, h));
  assert.ok(!hasProbe({ HOME: '/' }, h));
});

test('选了才记：监控标记 / pid / 它的子孙；没选的不记；pid 被复用了不算', async () => {
  const watches: Watch[] = [
    { id: 'w1', kind: 'pid', pid: 100, started_at: 5000, label: 'dsh', detail: null, cwd: null, opts: null, created_at: 0, ended_at: null },
    { id: 'w2', kind: 'pid', pid: 300, started_at: 5000, label: 'old', detail: null, cwd: null, opts: null, created_at: 0, ended_at: 1 },
  ];
  const table: Proc[] = [
    { pid: 100, ppid: 1, startedAt: 5000, args: 'node dsh' },
    { pid: 101, ppid: 100, startedAt: 6000, args: 'sh -c npm test' },
    { pid: 102, ppid: 101, startedAt: 6100, args: 'node test.mjs' },
    { pid: 200, ppid: 1, startedAt: 5000, args: 'node other' },
    { pid: 300, ppid: 1, startedAt: 5000, args: 'node ended' },
  ];
  const a = new Acceptor(() => watches, false, async () => table);
  assert.equal(await a.accepts({ pid: 100, watch: null }), true);
  assert.equal(await a.accepts({ pid: 102, watch: null }), true, 'dsh 跑 npm test 拉起的进程');
  assert.equal(await a.accepts({ pid: 200, watch: null }), false, '带着探针但没选');
  assert.equal(await a.accepts({ pid: 300, watch: null }), false, '停止监控了');
  assert.equal(await a.accepts({ pid: null, watch: null }), false);
  assert.equal(await a.accepts({ pid: 200, watch: 'w1' }), true, '我们挂上 / 重启时设的标记');
  assert.equal(await a.accepts({ pid: 200, watch: 'w2' }), false, '停掉的标记不算');
  assert.equal(await a.accepts({ pid: 200, watch: 'manual' }), true, '照「自己在终端里启动」的命令起的');
  assert.equal(await a.accepts({ pid: 200, watch: 'project:p1' }), true, '导入的项目');

  // pid 被复用：同一个 pid，启动时间对不上
  table[0] = { pid: 100, ppid: 1, startedAt: 99_000, args: 'node something-else' };
  a.reset();
  assert.equal(await a.accepts({ pid: 100, watch: null }), false);

  assert.equal(await new Acceptor(() => [], true, async () => []).accepts({ pid: 1, watch: null }), true, 'AGENTMAKE_RECORD_ALL=1 什么都记');
});

test('不重启挂探针：正在跑的 Node 进程装上之后，调试口马上关掉', { skip: process.platform === 'win32' }, async (t) => {
  // 9229 被占着时 attachNode 会拒绝（那是别人的调试器）—— 这时没法测，跳过
  if (await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(300) }).then(() => true, () => false)) return t.skip('9229 被占用');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    await new Promise((r) => setTimeout(r, 300));
    // 上报地址指向一个没人听的端口：装上就行，不需要真的上报
    const intercept = new URL('../src/harness/intercept.ts', import.meta.url).pathname;
    const r = await attachNode(child.pid!, { intercept, url: 'http://127.0.0.1:9', watch: 'w_test' });
    assert.deepEqual(r, { ok: true });
    await new Promise((res) => setTimeout(res, 300));
    const open = await fetch('http://127.0.0.1:9229/json/list', { signal: AbortSignal.timeout(300) }).then(() => true, () => false);
    assert.equal(open, false, '调试口已经关了');
  } finally {
    child.kill();
  }
});
