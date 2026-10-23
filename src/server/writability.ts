// 可回写性分析：把运行时捕获到的值，匹配回源码里的字面量。
//
// 这是「改 prompt」能不能落回代码的判据。三种结果必须**如实告诉用户** ——
// 「改完以为存下了、重跑还是老的」会直接毁掉工具的可信度。
//
//   static_literal    源码里就是这个字符串     → 精确替换
//   static_composed   模板拼接，骨架能对上     → 只能改静态片段，插值部分改不了
//   runtime_computed  匹配不上（来自变量/DB） → 表单改不了，但**源码随时能改**
//
// ⚠️ runtime_computed 不等于「这段没法改」。它只是说「表单那条捷径用不了」——
// 约束的是便捷层，不是能力边界。UI 与 MCP 的文案都必须体现这点。

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canParse, scanLiterals, type Literal } from './jsscan.ts';

export type Writability = 'static_literal' | 'static_composed' | 'runtime_computed' | 'unparsable';

export type Segment = {
  /** 这一段静态文本在源文件里的字节区间 */
  start: number;
  end: number;
  line: number;
  col: number;
  text: string;
};

export type WritabilityResult = {
  writability: Writability;
  file: string | null;
  line: number | null;
  /** 可编辑的静态片段。static_literal 只有一段；static_composed 有多段 */
  segments: Segment[];
  /** 分析时源文件内容的哈希 —— 回写前用它检测文件是否被外部改过 */
  fileHash: string | null;
  /** 给用户看的说明 */
  note: string;
};

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);

const NOTES: Record<Writability, string> = {
  static_literal: '源码里就是这个字符串，可精确替换。',
  static_composed:
    '这段是模板拼接出来的：静态部分可以改，${} 插值部分由运行时决定，改不了。',
  runtime_computed:
    '这个值在运行时算出来（来自变量、检索结果或外部数据），无法定位到唯一的源码位置。' +
    '表单改不了它 —— 但你随时可以直接改产生它的那段代码。',
  unparsable: '源文件无法解析（可能是 TypeScript 或语法有误），暂不支持定位。',
};

/**
 * @param value  运行时捕获到的值（如实际发出的 system prompt）
 * @param files  候选源文件（取自这次调用的调用栈帧，内层优先）
 */
export function analyze(value: string, files: string[]): WritabilityResult {
  if (!value) {
    return { writability: 'runtime_computed', file: null, line: null, segments: [], fileHash: null, note: NOTES.runtime_computed };
  }

  let sawUnparsable = false;

  for (const file of dedupe(files)) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!canParse(src)) {
      sawUnparsable = true;
      continue;
    }

    const lits = scanLiterals(src);

    // 1) 完全相同的字面量 —— 最理想的情况
    const exact = lits.find((l) => l.value === value);
    if (exact) {
      return {
        writability: 'static_literal',
        file,
        line: exact.line,
        segments: [seg(exact)],
        fileHash: sha(src),
        note: NOTES.static_literal,
      };
    }

    // 2) 模板拼接：把同一模板的静态片段按序拼回去，看能否套进运行时值
    const composed = matchTemplate(value, lits);
    if (composed) {
      return {
        writability: 'static_composed',
        file,
        line: composed[0].line,
        segments: composed.map(seg),
        fileHash: sha(src),
        note: NOTES.static_composed,
      };
    }
  }

  const w: Writability = sawUnparsable ? 'unparsable' : 'runtime_computed';
  return { writability: w, file: null, line: null, segments: [], fileHash: null, note: NOTES[w] };
}

/**
 * 模板匹配：quasis 必须按顺序出现在运行时值里，首片段贴着开头、尾片段贴着结尾。
 * 中间的空隙就是 ${} 插值填进去的内容。
 */
function matchTemplate(value: string, lits: Literal[]): Literal[] | null {
  const groups = new Map<number, Literal[]>();
  for (const l of lits) {
    if (l.templateId === undefined) continue;
    const g = groups.get(l.templateId);
    if (g) g.push(l);
    else groups.set(l.templateId, [l]);
  }

  let best: Literal[] | null = null;
  let bestCover = 0;

  for (const parts of groups.values()) {
    parts.sort((a, b) => (a.templateIndex ?? 0) - (b.templateIndex ?? 0));
    const texts = parts.map((p) => p.value);
    // 单片段模板等价于普通字符串，前面已经查过
    if (texts.length < 2) continue;

    // 骨架太短就可能是巧合命中（`${a}-${b}` 能匹配任何 "x-y"）。三点考量：
    //   · 用**静态文本总量**而非单片段长度 —— 中文信息密度高，三个字往往已经很具体
    //   · 刻意不看「静态占比」—— 真实 prompt 常是几百字骨架套几千字检索结果，
    //     按比例卡会把最该支持的场景挡在外面
    //   · 门槛取低不取高 —— 误报成「改不了」会让功能显得没用；而误配的风险由
    //     首尾锚定（值必须以首片段开头、末片段结尾）+ 写入前的语法与回读校验兜住
    const totalStatic = texts.reduce((s, t) => s + t.trim().length, 0);
    if (totalStatic < 4) continue;

    if (!value.startsWith(texts[0])) continue;
    if (!value.endsWith(texts[texts.length - 1])) continue;

    let pos = texts[0].length;
    let okAll = true;
    for (let i = 1; i < texts.length - 1; i++) {
      if (!texts[i]) continue; // 相邻插值之间可能没有静态文本
      const at = value.indexOf(texts[i], pos);
      if (at < 0) { okAll = false; break; }
      pos = at + texts[i].length;
    }
    if (!okAll) continue;

    const cover = texts.reduce((s, t) => s + t.length, 0);
    if (cover > bestCover) {
      bestCover = cover;
      best = parts;
    }
  }
  return best;
}

const seg = (l: Literal): Segment => ({
  start: l.start,
  end: l.end,
  line: l.line,
  col: l.col,
  text: l.value,
});

function dedupe(files: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // 内层帧（最后一个）最可能是构造 prompt 的地方，优先查
  for (const f of [...files].reverse()) {
    if (!f || seen.has(f)) continue;
    if (!/\.(mjs|cjs|js)$/.test(f)) continue; // TS 需要另一套解析，暂不支持
    seen.add(f);
    out.push(f);
  }
  return out;
}
