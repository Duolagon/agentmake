// 从调用栈还原「是哪个函数发出了这次调用」。
//
// 这是拦截式调试能推导出执行图的关键：只看 LLM 调用的话，news 整条流水线里
// 只有 compose 一处调模型，图只有一个节点。但调用栈能免费给出完整的函数层级
// （scout ← dispatch ← handleDispatch），不需要用户改一行代码。
//
// Node 默认开启 async stack traces，await 链能保留，所以这个信号在真实项目里可用。

export type Frame = {
  fn: string;
  file: string;
  line: number;
  col: number;
};

// 形如：
//   at callOpenAI (file:///Users/x/src/providers.mjs:360:15)
//   at async chat (file:///Users/x/src/providers.mjs:414:14)
//   at file:///Users/x/src/run.mjs:12:3            ← 顶层，无函数名
//   at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
const WITH_NAME = /^\s*at\s+(?:async\s+)?(.+?)\s+\((.+):(\d+):(\d+)\)\s*$/;
const BARE = /^\s*at\s+(?:async\s+)?(.+):(\d+):(\d+)\s*$/;

export function parseStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of stack.split('\n')) {
    let m = WITH_NAME.exec(line);
    if (m) {
      out.push({ fn: m[1], file: m[2], line: Number(m[3]), col: Number(m[4]) });
      continue;
    }
    m = BARE.exec(line);
    if (m) {
      out.push({ fn: '<top>', file: m[1], line: Number(m[2]), col: Number(m[3]) });
    }
  }
  return out;
}

/**
 * 只保留用户自己的代码帧。
 *
 * 判据刻意不依赖 cwd —— agent 可能从任意目录启动。规则：是 file:// 且不在
 * node_modules、不是 node 内部、不是 agentmake 自身。
 */
export function isUserFrame(f: Frame, selfDir: string): boolean {
  const file = f.file;
  if (!file.startsWith('file:') && !file.startsWith('/')) return false; // node:internal 等
  if (file.includes('/node_modules/')) return false;
  if (selfDir && file.includes(selfDir)) return false; // 别把调试器自己画进图里
  return true;
}

export function toPath(fileUrl: string): string {
  return fileUrl.startsWith('file://') ? decodeURIComponent(fileUrl.slice(7)) : fileUrl;
}

/**
 * 抓取当前调用栈中属于用户代码的部分，顺序为「最外层 → 最内层」。
 * 最内层就是直接发起这次调用的函数。
 */
export function captureFrames(selfDir: string, limit = 40): Frame[] {
  const saved = Error.stackTraceLimit;
  Error.stackTraceLimit = limit;
  const raw = new Error().stack ?? '';
  Error.stackTraceLimit = saved;

  const all = parseStack(raw)
    .filter((f) => isUserFrame(f, selfDir))
    .map((f) => ({ ...f, file: toPath(f.file) }));

  // 匿名帧（箭头函数、模块顶层）不带语义，夹在具名帧中间只会给图加噪声：
  //   chat → withRetry → <top> → callOpenAI   ⇒   chat → withRetry → callOpenAI
  const named = all.filter((f) => f.fn !== '<top>');

  // 但**全部都是匿名帧**时不能全丢 —— 那是「直接在模块顶层发起调用」的脚本，
  // 丢光会让这次调用彻底从执行图里消失（totals 归零，还会误报「没有捕获到调用」）。
  // 保留最内层那一帧，至少留下文件与行号。
  const frames = named.length ? named : all.slice(0, 1);

  // parseStack 给的是内→外，反过来更符合「调用路径」的直觉
  return frames.reverse();
}

/** 节点身份：同一文件同一函数视为同一节点。行号会变，不进 key。 */
export function frameKey(f: Frame): string {
  return `${f.file}#${f.fn}`;
}

/** 展示用短名：省掉目录，只留 文件名:函数名 */
export function frameLabel(f: Frame): string {
  const base = f.file.split('/').pop() ?? f.file;
  return f.fn === '<top>' ? base : `${f.fn}`;
}
