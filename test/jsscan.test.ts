// 扫描器单测。它给回写提供字节坐标，找错位置就等于改坏用户的代码 ——
// 所以对抗性用例（正则、转义、嵌套模板）比常规用例更重要。
import assert from 'node:assert/strict';
import test from 'node:test';
import { scanLiterals } from '../src/server/jsscan.ts';

const vals = (src: string) => scanLiterals(src).map((l) => l.value);

test('基本字符串与引号风格', () => {
  const src = `const a = 'hi'; const b = "there";`;
  const ls = scanLiterals(src);
  assert.deepEqual(ls.map((l) => l.value), ['hi', 'there']);
  assert.deepEqual(ls.map((l) => l.quote), ["'", '"']);
  // 区间不含引号本身
  assert.equal(src.slice(ls[0].start, ls[0].end), 'hi');
});

test('转义序列解码后再比较', () => {
  const ls = scanLiterals(String.raw`const s = 'line1\nline2\t\'quoted\'';`);
  assert.equal(ls[0].value, "line1\nline2\t'quoted'");
});

test('模板字面量按静态片段切分', () => {
  const src = 'const p = `你是助手。\n历史：${msgs}\n规则：${rules}`;';
  const ls = scanLiterals(src);
  assert.deepEqual(ls.map((l) => l.value), ['你是助手。\n历史：', '\n规则：', '']);
  assert.ok(ls.every((l) => l.inTemplate));
});

test('★ 正则里的引号不能被当成字符串', () => {
  const src = `const re = /it's a "test"/; const s = 'real';`;
  assert.deepEqual(vals(src), ['real'], '正则内容被误当字符串会导致坐标全错');
});

test('★ 除号不能被当成正则开头', () => {
  const src = `const x = a / b; const s = 'after';`;
  assert.deepEqual(vals(src), ['after']);
});

test('★ return 后面的斜杠是正则', () => {
  const src = `function f(){ return /a'b/.test(x); } const s = 'ok';`;
  assert.deepEqual(vals(src), ['ok']);
});

test('注释里的引号被忽略', () => {
  const src = `// don't touch this\n/* nor "this" */\nconst s = 'kept';`;
  assert.deepEqual(vals(src), ['kept']);
});

test('嵌套模板与内层字符串', () => {
  const src = 'const s = `outer ${ inner(`deep ${x} end`) } tail`;';
  const v = vals(src);
  assert.ok(v.includes('outer '), '外层前段');
  assert.ok(v.includes(' tail'), '外层后段');
  assert.ok(v.includes('deep '), '内层模板前段');
});

test('模板 ${} 里的普通字符串也能被找到', () => {
  const src = 'const s = `a${ f("mid") }b`;';
  const v = vals(src);
    assert.ok(v.includes('mid'), '嵌套表达式里的字符串');
  assert.ok(v.includes('a') && v.includes('b'), '模板两段');
});

test('行列号可用于跳转编辑器', () => {
  const src = `const a = 1;\nconst b = 2;\nconst s = 'target';`;
  const l = scanLiterals(src).find((x) => x.value === 'target');
  assert.equal(l?.line, 3);
});

test('真实形态：多行 system prompt', () => {
  const src = [
    'const SYSTEM = `你是一份日报的主编。',
    '',
    '【规则】必须用简体中文。`;',
    "const other = 'x';",
  ].join('\n');
  const ls = scanLiterals(src);
  assert.ok(ls[0].value.includes('日报的主编'));
  assert.ok(ls[0].value.includes('必须用简体中文'));
  assert.equal(ls[0].line, 1);
});
