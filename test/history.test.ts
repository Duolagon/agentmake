// 历史会话栏：一条 = 一次干活，人认得出（任务原文）、找得到（不被噪音淹没）。
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildHistory, cleanTask, programName, type HistoryRun, type RunStats } from '../src/server/history.ts';

const NOW = 10_000_000;
const run = (id: string, extra: Partial<HistoryRun> = {}): HistoryRun => ({
  run_id: id, kind: 'process', parent_run_id: null, spawned_by: null, trigger: null,
  cwd: '/work/app', argv: JSON.stringify(['/work/app/agent.mjs']), pid: 1, started_at: 1000, ended_at: 2000, replay_of: null,
  ...extra,
});
const stat = (llm: number, extra: Partial<RunStats> = {}): RunStats => ({
  llm, tool: 0, tokensIn: 100, tokensOut: 10, errors: 0, pending: 0, firstAt: 1000, lastAt: 1500, models: 'm', ...extra,
});

function hist(runs: HistoryRun[], stats: Record<string, RunStats>, extra: { tasks?: Record<string, string>; alive?: (pid: number) => boolean; failing?: Record<string, number>; q?: string } = {}) {
  return buildHistory({
    runs,
    stats: new Map(Object.entries(stats)),
    failing: new Map(Object.entries(extra.failing ?? {})),
    tasks: new Map(Object.entries(extra.tasks ?? {})),
    alive: extra.alive ?? (() => false),
    now: NOW,
    q: extra.q,
  });
}

test('一次性脚本是一条，标题是交给 agent 的任务原文', () => {
  const h = hist([run('a')], { a: stat(3) }, { tasks: { a: '总结以下 3 条材料' } });
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].task, '总结以下 3 条材料');
  assert.equal(h.entries[0].program, 'agent.mjs · app');
  assert.equal(h.entries[0].status, 'done');
});

test('★ 常驻服务：每一轮对话（入站请求）各自一条，进程本身不单列、不算「空运行」', () => {
  const dsh = run('dsh', { argv: JSON.stringify(['/opt/homebrew/bin/dsh', 'web', '--no-open']), cwd: '/Users/x/deepseekhsh', ended_at: null });
  const t1 = run('dsh_r1', { kind: 'request', parent_run_id: 'dsh', trigger: 'POST /api/session/prompt', started_at: 1100 });
  const t2 = run('dsh_r2', { kind: 'request', parent_run_id: 'dsh', trigger: 'POST /api/session/prompt', started_at: 1200 });
  const h = hist([dsh, t1, t2], { dsh_r1: stat(44), dsh_r2: stat(5, { firstAt: 1200 }) }, { tasks: { dsh_r1: '测试当前服务', dsh_r2: '再看看' } });
  assert.deepEqual(h.entries.map((e) => e.runId), ['dsh_r2', 'dsh_r1']);
  assert.equal(h.entries[0].program, 'dsh web · deepseekhsh', '程序名取自进程');
  assert.equal(h.hiddenEmpty, 0);
});

test('★ 子进程挂在拉起它的那一条下面，不单列', () => {
  const runs = [
    run('dsh', { ended_at: null }),
    run('dsh_r1', { kind: 'request', parent_run_id: 'dsh' }),
    run('npm-test', { spawned_by: 'dsh_r1', argv: JSON.stringify(['/opt/homebrew/bin/npm', 'test']) }),
    run('e2e', { spawned_by: 'npm-test', argv: JSON.stringify(['/x/run-e2e.mjs']) }),
  ];
  const h = hist(runs, { dsh_r1: stat(10), e2e: stat(6) });
  assert.deepEqual(h.entries.map((e) => e.runId), ['dsh_r1'], '跑测试冒出来的子进程不占列表');
  assert.deepEqual(h.entries[0].children.map((k) => [k.runId, k.calls]), [['npm-test', 0], ['e2e', 6]], '子进程的子进程也列出来：真正干活的是 npm 拉起的脚本');
});

test('★ 包装进程（npm start → node agent.mjs）：自己不调模型，那子进程就是那一条', () => {
  const runs = [
    run('npm', { argv: JSON.stringify(['/opt/homebrew/bin/npm', 'start']) }),
    run('agent', { spawned_by: 'npm' }),
  ];
  const h = hist(runs, { agent: stat(7) });
  assert.deepEqual(h.entries.map((e) => e.runId), ['agent']);
});

test('一次模型都没调过的（健康检查、只抓数据的脚本、空进程）不列，只报个数', () => {
  const h = hist([run('a'), run('tool-only'), run('empty')], { a: stat(1), 'tool-only': stat(0, { tool: 3 }) });
  assert.deepEqual(h.entries.map((e) => e.runId), ['a']);
  assert.equal(h.hiddenEmpty, 2);
});

test('状态：进程还在且有调用没回来 = 在跑；进程没了还有调用没回来 = 中断；跑完之后进程才被关的 = 完成', () => {
  const live = hist([run('a', { ended_at: null })], { a: stat(2, { pending: 1 }) }, { alive: () => true });
  assert.equal(live.entries[0].status, 'running');
  const cut = hist([run('a', { ended_at: null })], { a: stat(2, { pending: 1 }) });
  assert.equal(cut.entries[0].status, 'interrupted');
  const doneThenKilled = hist([run('p', { ended_at: null }), run('p_r1', { kind: 'request', parent_run_id: 'p', ended_at: null })], { p_r1: stat(44) });
  assert.equal(doneThenKilled.entries[0].status, 'done', '一轮对话早就跑完，只是后来 dsh 被关掉');
  const bad = hist([run('a')], { a: stat(2, { errors: 1 }) });
  assert.equal(bad.entries[0].status, 'failed');
});

test('搜索：任务原文、程序名、模型都能搜到', () => {
  const runs = [run('a'), run('b', { argv: JSON.stringify(['/x/news.py']) })];
  const stats = { a: stat(1, { models: 'deepseek-flash' }), b: stat(1) };
  const tasks = { a: '测试当前服务', b: '分析这条新闻' };
  assert.deepEqual(hist(runs, stats, { tasks, q: '新闻' }).entries.map((e) => e.runId), ['b']);
  assert.deepEqual(hist(runs, stats, { tasks, q: 'news.py' }).entries.map((e) => e.runId), ['b']);
  assert.deepEqual(hist(runs, stats, { tasks, q: 'deepseek' }).entries.map((e) => e.runId), ['a']);
});

test('任务原文：去掉框架拼在后面的运行时上下文（dsh 连换行都没有），太长截断', () => {
  assert.equal(cleanTask('你是一名测试ai，测试当前服务是否符合预期，以及有没有bugCurrent runtime context. This snapshot…'),
    '你是一名测试ai，测试当前服务是否符合预期，以及有没有bug');
  assert.equal(cleanTask('  多行\n\n任务  '), '多行 任务');
  assert.equal(cleanTask('x'.repeat(200))!.length, 141);
  assert.equal(cleanTask(''), null);
});

test('程序名：程序 + 子命令 + 目录；没有 argv 时退到目录名', () => {
  assert.equal(programName({ argv: JSON.stringify(['/opt/homebrew/bin/dsh', 'web', '--port', '3081']), cwd: '/Users/x/deepseekhsh', run_id: 'r' }), 'dsh web · deepseekhsh');
  assert.equal(programName({ argv: JSON.stringify(['/a/b/agent.py']), cwd: '/w/proj', run_id: 'r' }), 'agent.py · proj');
  assert.equal(programName({ argv: '[]', cwd: '/w/proj', run_id: 'r' }), 'proj');
});
