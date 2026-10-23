// 用 acorn 解析源码，取出所有字符串字面量及其字节坐标。
//
// 为什么要真 AST 而不是自己扫字符：回写是往用户源码里写字节，位置错一位就是改坏代码。
// 手写扫描器躲不开正则字面量与除号的歧义（`/it's/` 里的引号会被当成字符串起点），
// 而这类误判正好会污染坐标。解析器把这些歧义一次性解决掉。
//
// 只取坐标、不做代码生成：回写是对原文的字节切片替换，未改动的部分逐字节保持原样，
// 不会出现「格式化整个文件」这种灾难。

import { parse } from 'acorn';
import * as walk from 'acorn-walk';

export type Literal = {
  /** 字面量内容（转义已解码，与运行时拿到的值可直接比较） */
  value: string;
  /** 可替换区间：**不含**引号/反引号，是内容本身的字节范围 */
  start: number;
  end: number;
  /** 引号风格：' " ` */
  quote: "'" | '"' | '`';
  /** 是模板字面量里的静态片段（说明整段 prompt 是拼接出来的） */
  inTemplate: boolean;
  /** 同一个模板字面量的所有片段共享此 id，用来把它们还原成一组 */
  templateId?: number;
  /** 在所属模板中的序号 */
  templateIndex?: number;
  line: number;
  col: number;
};

type Pos = { line: number; col: number };

function lineIndex(src: string): (idx: number) => Pos {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (idx: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: idx - starts[lo] };
  };
}

/** 解析失败时不抛 —— 调用方要能优雅降级为「这个文件无法分析」 */
export function scanLiterals(src: string): Literal[] {
  let ast: any;
  try {
    ast = parse(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowReturnOutsideFunction: true,
      locations: false,
    });
  } catch {
    try {
      ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
    } catch {
      return [];
    }
  }

  const posOf = lineIndex(src);
  const out: Literal[] = [];

  walk.full(ast, (node: any) => {
    if (node.type === 'Literal' && typeof node.value === 'string') {
      // node.start/end 含引号，内容区间要各缩一位
      const quote = src[node.start] as "'" | '"';
      if (quote !== "'" && quote !== '"') return; // 正则字面量的 Literal 也会走到这
      out.push({
        value: node.value,
        start: node.start + 1,
        end: node.end - 1,
        quote,
        inTemplate: false,
        ...posOf(node.start + 1),
      });
      return;
    }

    if (node.type === 'TemplateLiteral') {
      // quasi 的 start/end 已经就是静态片段本身的区间（不含 ` 和 ${}）
      const tid = node.start; // 模板起始偏移天然唯一，直接当组 id
      (node.quasis as any[]).forEach((q, idx) => {
        out.push({
          value: q.value.cooked ?? q.value.raw,
          start: q.start,
          end: q.end,
          quote: '`',
          inTemplate: true,
          templateId: tid,
          templateIndex: idx,
          ...posOf(q.start),
        });
      });
    }
  });

  return out.sort((a, b) => a.start - b.start);
}

/** 源文件是否可分析 —— 语法有问题时明确告知，而不是当成「没有字面量」 */
export function canParse(src: string): boolean {
  try {
    parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
    return true;
  } catch {
    try {
      parse(src, { ecmaVersion: 'latest', sourceType: 'script', allowHashBang: true });
      return true;
    } catch {
      return false;
    }
  }
}
