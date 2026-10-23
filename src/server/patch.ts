// 把改好的文本写回源码。
//
// 这是整个项目里唯一会修改用户资产的代码，安全网做了三重：
//   1. 内容哈希冲突检测 —— 分析之后文件被外部改过就拒绝，绝不覆盖别人的修改
//   2. 写后真解析校验   —— 用 acorn 重新解析，不通过就整体放弃
//   3. 自动备份         —— 写前复制到 .agentmake/backups/，可一键回退
//
// 落盘策略是「直接写 + 可撤销」而不是「先 review 再 apply」：本地自用、改自己的代码、
// 有 git，真正的安全网是备份与 git，不是确认弹窗。

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { canParse, scanLiterals } from './jsscan.ts';

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

export type EditRequest = {
  file: string;
  /** 要替换的区间（来自可回写性分析的 segment），不含引号 */
  start: number;
  end: number;
  newText: string;
  /** 分析时的文件哈希，用于冲突检测 */
  fileHash?: string;
};

export type EditResult = {
  ok: boolean;
  error?: string;
  backup?: string;
  /** 便于展示的前后对照 */
  before?: string;
  after?: string;
};

const BACKUP_ROOT = path.resolve(process.cwd(), '.agentmake', 'backups');

/** 把文本编码进指定引号风格的字面量内容区 */
function encode(text: string, quote: "'" | '"' | '`'): string {
  if (quote === '`') {
    // 模板片段：反引号、反斜杠、以及 ${ 都要转义，否则会改变模板结构
    return text.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
  }
  return text
    .replace(/\\/g, '\\\\')
    .replace(new RegExp(quote, 'g'), `\\${quote}`)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n'); // 普通字符串不能跨行，换行必须转义
}

export function applyEdit(req: EditRequest): EditResult {
  let src: string;
  try {
    src = readFileSync(req.file, 'utf8');
  } catch (e) {
    return { ok: false, error: `读不到文件：${e instanceof Error ? e.message : e}` };
  }

  // ① 冲突检测：分析之后文件被改过就停手
  if (req.fileHash && sha(src) !== req.fileHash) {
    return {
      ok: false,
      error: '源文件在分析之后被改动过（可能是你在编辑器里改了，或 AI 改了）。请刷新重新分析后再试。',
    };
  }

  if (req.start < 0 || req.end > src.length || req.start > req.end) {
    return { ok: false, error: '替换区间越界 —— 分析结果可能已过期' };
  }

  // 定位这个区间对应的字面量，拿到它的引号风格
  const lit = scanLiterals(src).find((l) => l.start === req.start && l.end === req.end);
  if (!lit) {
    return { ok: false, error: '该位置已不是一个字符串字面量 —— 源码已变化，请重新分析' };
  }

  const before = src.slice(req.start, req.end);
  let quote = lit.quote;
  let head = req.start;
  let tail = req.end;
  let payload = encode(req.newText, quote);

  // 普通字符串塞不下换行；真要多行就把整个字面量升级成模板，连引号一起换
  if (quote !== '`' && /\n/.test(req.newText)) {
    head = req.start - 1;
    tail = req.end + 1;
    quote = '`';
    payload = '`' + encode(req.newText, '`') + '`';
  }

  const next = src.slice(0, head) + payload + src.slice(tail);

  // ② 写后校验：用真解析器确认没把代码改坏
  if (!canParse(next)) {
    return { ok: false, error: '改动会导致源文件语法错误，已放弃（文件未被修改）' };
  }
  // 再确认新值确实落在了预期位置
  const check = scanLiterals(next).find((l) => l.start === head + (quote === '`' && head !== req.start ? 1 : 0));
  if (check && check.value !== req.newText) {
    return { ok: false, error: '写回后的内容与预期不符，已放弃（文件未被修改）' };
  }

  // ③ 备份后落盘
  let backup: string | undefined;
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(BACKUP_ROOT, stamp);
    mkdirSync(dir, { recursive: true });
    backup = path.join(dir, path.basename(req.file));
    copyFileSync(req.file, backup);
  } catch {
    return { ok: false, error: '无法创建备份，出于安全考虑放弃写入' };
  }

  try {
    writeFileSync(req.file, next, 'utf8');
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : e}` };
  }

  return { ok: true, backup, before, after: req.newText };
}

/** 从备份还原 —— 撤销按钮的实现 */
export function revert(file: string, backup: string): EditResult {
  try {
    const content = readFileSync(backup, 'utf8');
    writeFileSync(file, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: `还原失败：${e instanceof Error ? e.message : e}` };
  }
}
