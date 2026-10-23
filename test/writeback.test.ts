// 可回写性分析 + 源码回写。
// 这是唯一会改用户资产的代码路径，安全网（冲突检测 / 语法校验 / 备份）必须逐条验证。
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { analyze } from '../src/server/writability.ts';
import { applyEdit } from '../src/server/patch.ts';

const tmp = mkdtempSync(path.join(tmpdir(), 'am-wb-'));
let n = 0;
function fixture(code: string): string {
  const f = path.join(tmp, `f${n++}.mjs`);
  writeFileSync(f, code, 'utf8');
  return f;
}

// ── 分析 ──

test('static_literal：源码里就是这个字符串', () => {
  const f = fixture(`const SYS = '你是一个工单分析助手。';\nexport { SYS };`);
  const r = analyze('你是一个工单分析助手。', [f]);
  assert.equal(r.writability, 'static_literal');
  assert.equal(r.line, 1);
  assert.equal(r.segments.length, 1);
});

test('static_composed：模板拼接，骨架能对上', () => {
  const f = fixture([
    'export function build(state, rules) {',
    '  return `你是助手。',
    '历史：${state.messages}',
    '规则：${rules}`;',
    '}',
  ].join('\n'));
  // 运行时真实发出的值（插值已展开）
  const runtime = '你是助手。\n历史：[msg1,msg2]\n规则：不要瞎编';
  const r = analyze(runtime, [f]);
  assert.equal(r.writability, 'static_composed');
  assert.equal(r.segments.length, 3, '三个静态片段都定位到了');
  assert.ok(r.segments[0].text.includes('你是助手'));
  assert.ok(r.note.includes('插值部分'), '文案要说清哪部分改不了');
});

test('runtime_computed：值来自外部，定位不到', () => {
  const f = fixture(`export async function build(db){ return await db.get('prompt'); }`);
  const r = analyze('这段内容完全来自数据库，源码里根本没有', [f]);
  assert.equal(r.writability, 'runtime_computed');
  assert.match(r.note, /随时可以直接改产生它的那段代码/, '★ 必须说明这不等于改不了');
});

test('语法有误的文件明确报 unparsable，而不是「没有字面量」', () => {
  const f = fixture(`const a = ;;; broken(`);
  const r = analyze('随便什么', [f]);
  assert.equal(r.writability, 'unparsable');
});

test('骨架太短的模板不做匹配（避免巧合命中）', () => {
  const f = fixture('export const x = `${a}-${b}`;');
  const r = analyze('foo-bar', [f]);
  assert.equal(r.writability, 'runtime_computed');
});

// ── 回写 ──

test('★ 回写单引号字符串：只动那一段，其余逐字节不变', () => {
  const code = `import x from 'y';\nconst SYS = '旧提示';\nconst other = 'keep me';\n// 注释保留\n`;
  const f = fixture(code);
  const r = analyze('旧提示', [f]);
  const res = applyEdit({ file: f, ...r.segments[0], newText: '新提示', fileHash: r.fileHash! });
  assert.ok(res.ok, res.error);
  const after = readFileSync(f, 'utf8');
  assert.equal(after, `import x from 'y';\nconst SYS = '新提示';\nconst other = 'keep me';\n// 注释保留\n`);
});

test('★ 多行内容自动升级成模板字面量', () => {
  const f = fixture(`const SYS = '单行';`);
  const r = analyze('单行', [f]);
  const res = applyEdit({ file: f, ...r.segments[0], newText: '第一行\n第二行', fileHash: r.fileHash! });
  assert.ok(res.ok, res.error);
  assert.equal(readFileSync(f, 'utf8'), 'const SYS = `第一行\n第二行`;');
});

test('★ 转义正确：引号、反斜杠、${ 都不会破坏语法', () => {
  for (const [code, oldVal, newVal] of [
    [`const a = '旧';`, '旧', `含'单引号'和\\反斜杠`],
    [`const a = "旧";`, '旧', '含"双引号"'],
    ['const a = `旧`;', '旧', '含 ${不是插值} 和 `反引号`'],
  ] as const) {
    const f = fixture(code);
    const r = analyze(oldVal, [f]);
    const res = applyEdit({ file: f, ...r.segments[0], newText: newVal, fileHash: r.fileHash! });
    assert.ok(res.ok, `${code} → ${res.error}`);
    // 用真解析器确认改完还能解析，且值就是我们写的
    const r2 = analyze(newVal, [f]);
    assert.equal(r2.writability, 'static_literal', `写回后读不回来：${readFileSync(f, 'utf8')}`);
  }
});

test('★ 冲突检测：分析后文件被改过就拒绝', () => {
  const f = fixture(`const SYS = '旧';`);
  const r = analyze('旧', [f]);
  writeFileSync(f, `const SYS = '被别人改了';`, 'utf8'); // 模拟 IDE/AI 同时改了
  const res = applyEdit({ file: f, ...r.segments[0], newText: '我的改动', fileHash: r.fileHash! });
  assert.equal(res.ok, false);
  assert.match(res.error!, /被改动过/);
  assert.equal(readFileSync(f, 'utf8'), `const SYS = '被别人改了';`, '别人的修改必须原样保住');
});

test('★ 备份可用于还原', async () => {
  const f = fixture(`const SYS = '原始';`);
  const r = analyze('原始', [f]);
  const res = applyEdit({ file: f, ...r.segments[0], newText: '改过', fileHash: r.fileHash! });
  assert.ok(res.backup);
  assert.equal(readFileSync(res.backup!, 'utf8'), `const SYS = '原始';`);
  const { revert } = await import('../src/server/patch.ts');
  revert(f, res.backup!);
  assert.equal(readFileSync(f, 'utf8'), `const SYS = '原始';`);
});

test('区间过期时拒绝写入', () => {
  const f = fixture(`const SYS = '旧';`);
  const res = applyEdit({ file: f, start: 9999, end: 10000, newText: 'x' });
  assert.equal(res.ok, false);
});

test('模板片段回写只改该片段，插值原样保留', () => {
  const f = fixture('export const p = (a) => `前缀：${a} 后缀`;');
  const r = analyze('前缀：X 后缀', [f]);
  assert.equal(r.writability, 'static_composed');
  const res = applyEdit({ file: f, ...r.segments[0], newText: '新前缀：', fileHash: r.fileHash! });
  assert.ok(res.ok, res.error);
  assert.equal(readFileSync(f, 'utf8'), 'export const p = (a) => `新前缀：${a} 后缀`;');
});
