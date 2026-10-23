// Node 模块加载钩子：在用户模块进内存时给循环插桩。
//
// 只转换用户自己的代码 —— node_modules、node: 内置、以及 agentmake 自身一律跳过。
// 转换失败或解析失败时原样放行，绝不能让用户的模块加载不起来。

import { fileURLToPath } from 'node:url';
import { transformLoops } from './loop-transform.ts';

const SELF = '/agentmake/src/';

function shouldTransform(url) {
  if (!url.startsWith('file:')) return false;
  if (url.includes('/node_modules/')) return false;
  if (url.includes(SELF)) return false;
  return /\.(mjs|js|cjs)$/.test(url);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!shouldTransform(url) || result.format === 'commonjs' || !result.source) return result;

  try {
    const src = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    const { code, loops } = transformLoops(src, fileURLToPath(url));
    if (!loops.length) return result;
    return { ...result, source: code };
  } catch {
    return result; // 插桩出任何问题都不影响用户代码加载
  }
}
