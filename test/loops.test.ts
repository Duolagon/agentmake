// 循环插桩不能改变原程序的语义。
import assert from 'node:assert/strict';
import test from 'node:test';
import { transformLoops } from '../src/harness/loop-transform.ts';
import { loopTest } from '../src/harness/loops.ts';

const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;

/** 把一段代码插桩后跑起来，返回它算出的值 */
async function runBoth(body: string, hook: unknown): Promise<[unknown, unknown]> {
  // 包进 async 箭头函数：顶层 return 在模块里解析不了，插桩会原样放行，测试就成了空跑
  const wrapped = `globalThis.__am_out = (async () => { ${body} })();`;
  const { code, loops } = transformLoops(wrapped, '/t.mjs');
  assert.ok(loops.length > 0 && code !== wrapped, '确实插桩了');
  const g = globalThis as any;
  const saved = g.__am_test;
  try {
    g.__am_test = hook;
    const plain = await new AsyncFn(body)();
    new Function(code)();
    const probed = await g.__am_out;
    return [plain, probed];
  } finally {
    g.__am_test = saved;
  }
}

const CASES: [string, string][] = [
  ['条件是 undefined', 'let n=0; let x; while (x) { n++; if (n>5) break; } return n;'],
  ['条件是 null', 'let n=0; for (let i=null; i; ) { n++; if (n>5) break; } return n;'],
  ['条件是 0 / 空串', 'let n=0; while (0) n++; do { n++; } while (""); return n;'],
  ['正常计数', 'let n=0; for (let i=0; i<3; i++) n++; return n;'],
  ['条件里有 await', 'let n=0; const f=async()=>n<2; while (await f()) n++; return n;'],
  ['条件里嵌套循环', 'let n=0; while ([1,2].some((v)=>{ for (let j=0;j<1;j++){} return n<v; })) n++; return n;'],
];

for (const [name, body] of CASES) {
  test(`插桩前后跑的轮数一样：${name}（钩子没装）`, async () => {
    const [a, b] = await runBoth(body, undefined);
    assert.equal(b, a);
  });
  test(`插桩前后跑的轮数一样：${name}（钩子装了、没有覆写）`, async () => {
    const [a, b] = await runBoth(body, loopTest);
    assert.equal(b, a);
  });
}

test('钩子没有覆写时原样返回原条件的值，不转成布尔', () => {
  assert.equal(loopTest('/x.mjs:1', undefined), undefined);
  assert.equal(loopTest('/x.mjs:1', null), null);
  assert.equal(loopTest('/x.mjs:1', 'abc'), 'abc');
});
