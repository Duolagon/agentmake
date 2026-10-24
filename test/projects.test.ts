// 导入项目的启动 / 收尾：启动失败不能留下一个「运行中」的空壳。
import assert from 'node:assert/strict';
import test from 'node:test';
import { start, stateOf, stopAll } from '../src/server/projects.ts';

const env = { harnessPath: '/x/register.ts', pyHarnessPath: '/x/py', url: 'http://127.0.0.1:1' };
const noop = () => {};

test('项目目录不存在：直接报错，不显示运行中，修好后能再次启动', async () => {
  const p = { id: 'p-missing', name: 'x', dir: '/definitely/not/here/agentmake', kind: 'node', cmd: 'exit 0', trigger: null };
  const r = start(p as never, env, noop, noop);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /目录不存在/);
  assert.equal(stateOf(p.id).running, false);

  const exited = new Promise<number | null>((resolve) => {
    const again = start({ ...p, dir: process.cwd() } as never, env, noop, (_id, code) => resolve(code));
    assert.equal(again.ok, true, '不会被「已经在跑了」挡住');
  });
  assert.equal(await exited, 0);
  assert.equal(stateOf(p.id).running, false);
  stopAll();
});
