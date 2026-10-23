// 循环插桩：在模块加载时给用户代码里的每个循环装上钩子。
//
// 为什么必须插桩：手写 agent 的循环是 `for (let i=0; i<MAX; i++)`，`i` 和 `MAX` 是
// 闭包变量，从 fetch 边界看不见也改不了。要做到「实时调整 loop 方式」，只能在循环
// 本身上动手。
//
// 两个注入点：
//   test 位置 → __am_test(id, 原条件)   可强制为 false（跳出）或 true（再来一轮）
//   body 开头 → __am_enter(id)          上报轮次，并在循环断点上阻塞
//
// 不改用户磁盘上的文件：转换发生在 Node 的 load 钩子里，只影响本进程内存中的模块。
// 用字节切片插入而不是重新生成代码，未改动的部分逐字节保持原样，行号也不漂移
// （注入的代码全部写在同一行内）。

import { parse } from 'acorn';
import * as walk from 'acorn-walk';

type Edit = { at: number; text: string } | { from: number; to: number; text: string };

export type LoopSite = { id: string; line: number; endLine: number; kind: string };

export type TransformResult = { code: string; loops: LoopSite[] };

const LOOP_TYPES = new Set([
  'ForStatement',
  'WhileStatement',
  'DoWhileStatement',
  'ForOfStatement',
  'ForInStatement',
]);

export function transformLoops(src: string, filename: string): TransformResult {
  let ast: any;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, locations: true });
  } catch {
    return { code: src, loops: [] }; // 解析不了就原样放行，绝不能让用户的模块加载失败
  }

  const edits: Edit[] = [];
  const loops: LoopSite[] = [];

  // 记录每个节点的祖先链，用来判断所在函数是不是 async（决定能否 await）
  const asyncStack: boolean[] = [false];

  walk.ancestor(ast, {
    Function(node: any) {
      void node;
    },
  });

  // ancestor walker 拿祖先更直接
  walk.ancestor(ast as any, {
    ForStatement: visit,
    WhileStatement: visit,
    DoWhileStatement: visit,
    ForOfStatement: visit,
    ForInStatement: visit,
  } as any);

  function visit(node: any, _state: unknown, ancestors: any[]): void {
    if (!LOOP_TYPES.has(node.type)) return;

    const line = node.loc?.start.line ?? 0;
    // 结束行必须一起带出去。只有起始行的话，服务端判断「这次调用在不在循环体内」
    // 只能用「同文件且行号 ≥ 循环起始行」—— 而这会让文件靠前的任意一个循环
    // （比如 readBody 里读请求体的 for await）把整个文件后面所有调用都吞进去。
    const endLine = node.loc?.end.line ?? line;
    const id = `${filename}:${line}`;
    loops.push({ id, line, endLine, kind: node.type });

    // 只有在 async 函数体内才能 await；否则退化成同步上报（仍支持跳出/改上限）
    const canAwait = ancestors.some(
      (a) => (a.type === 'FunctionDeclaration' || a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') && a.async,
    ) || ancestors.every((a) => a.type === 'Program' || a.type === 'ExpressionStatement'); // 顶层 await

    // ① 条件位置：包一层，可被覆写
    if (node.test) {
      edits.push({ from: node.test.start, to: node.test.start, text: `globalThis.__am_test?.(${JSON.stringify(id)},(` });
      edits.push({ from: node.test.end, to: node.test.end, text: `))??true` });
    } else if (node.type === 'ForStatement') {
      // for(;;) 无条件：插一个纯钩子条件
      edits.push({ at: node.start + 'for('.length, text: '' }); // 占位，实际由 body 守卫处理
    }

    // ② 循环体开头：上报轮次 + 断点阻塞
    const guard = canAwait
      ? `if((await globalThis.__am_enter?.(${JSON.stringify(id)},${endLine}))==='break')break;`
      : `if(globalThis.__am_enter_sync?.(${JSON.stringify(id)},${endLine})==='break')break;`;

    if (node.body.type === 'BlockStatement') {
      edits.push({ at: node.body.start + 1, text: guard });
    } else {
      // 单语句循环体，先补花括号
      edits.push({ at: node.body.start, text: `{${guard}` });
      edits.push({ at: node.body.end, text: `}` });
    }
  }

  if (!edits.length) return { code: src, loops };

  // 从后往前应用，避免前面的插入让后面的偏移失效
  const norm = edits
    .map((e) => ('at' in e ? { from: e.at, to: e.at, text: e.text } : e))
    .filter((e) => e.text)
    .sort((a, b) => b.from - a.from);

  let out = src;
  for (const e of norm) out = out.slice(0, e.from) + e.text + out.slice(e.to);

  // 转换后必须仍然可解析，否则宁可放弃插桩也不能弄坏用户的模块
  try {
    parse(out, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true });
  } catch {
    return { code: src, loops: [] };
  }

  return { code: out, loops };
}
