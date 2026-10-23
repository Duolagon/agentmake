// --import 入口：零侵入接入。
//
//   node --import /path/to/agentmake/src/harness/register.ts your-app.mjs
//   NODE_OPTIONS='--import /path/to/.../register.ts' npm start
//
// 用户代码一行不改。这是 Node 侧对应 Python `.pth` 自动附着的机制，而且更干净
// （只影响显式带上这个标志的进程，不会污染整个环境）。
//
// 安全阀：AGENTMAKE=0 直接关闭。

if (process.env.AGENTMAKE !== '0') {
  try {
    const { install } = await import('./intercept.ts');
    install();
  } catch (err) {
    // 装不上就装不上，绝不能让用户的程序起不来
    if (process.env.AGENTMAKE_DEBUG) console.error('[agentmake] install failed:', err);
  }

  // 循环插桩：注册模块加载钩子，给用户代码里的循环装上可控的条件与轮次上报。
  // 必须在用户模块被 import 之前注册，所以放在 --import 入口里。
  if (process.env.AGENTMAKE_LOOPS !== '0') {
    try {
      const { register } = await import('node:module');
      register('./loader.mjs', import.meta.url);
    } catch (err) {
      if (process.env.AGENTMAKE_DEBUG) console.error('[agentmake] loop hook failed:', err);
    }
  }
}
