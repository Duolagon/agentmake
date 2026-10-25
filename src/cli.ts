#!/usr/bin/env node
// 命令行入口。
//
// package.json 里 `bin` 早就声明了这个文件，但它一直不存在 —— `npm link` 之后
// 敲 `agentmake` 会直接崩。用户装完的第一个动作就撞墙，比没有这个命令还糟。
//
//   agentmake            起调试器（默认）
//   agentmake mcp        起 MCP server（给 AI 编程助手用，stdio 协议）
//   agentmake attach     打印接入命令，不启动任何东西

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const cmd = process.argv[2] ?? 'serve';

switch (cmd) {
  case 'serve':
  case undefined:
    await import('./server/index.ts');
    break;

  case 'mcp':
    // ⚠️ MCP 走 stdio，stdout 必须只有协议内容 —— 这里一个字都不能多打
    await import('./mcp/server.ts');
    break;

  case 'attach': {
    // 调试器不在默认端口时（AGENTMAKE_PORT / AGENTMAKE_URL），命令里必须带上 AGENTMAKE_URL ——
    // 否则探针按缺省连 8787，记录要么丢了，要么报到另一个实例里去
    const url = (process.env.AGENTMAKE_URL || `http://127.0.0.1:${process.env.AGENTMAKE_PORT || 8787}`).replace(/\/$/, '');
    const target = url === 'http://127.0.0.1:8787' ? '' : `AGENTMAKE_URL=${url} `;
    console.log('在你的项目目录下执行（代码一行不改）：\n');
    console.log(`  Node:    ${target}NODE_OPTIONS="--import ${path.join(HERE, 'harness/register.ts')}" node your-app.mjs`);
    console.log(`  Python:  ${target}PYTHONPATH="${path.join(HERE, 'pyharness')}" python -m agentmake your_agent.py`);
    console.log(`  其它语言: OPENAI_BASE_URL=${url}/p/openai/v1  <你的启动命令>`);
    console.log(`\n或者直接打开 ${url}，在页面上导入项目、点 ▶ 启动。`);
    break;
  }

  case '-h':
  case '--help':
  case 'help':
    console.log(
      [
        'agentmake —— Agent 可视化调试器',
        '',
        '  agentmake            起调试器，浏览器打开 http://127.0.0.1:8787',
        '  agentmake mcp        起 MCP server（给 AI 编程助手用）',
        '  agentmake attach     打印接入命令',
        '',
        '环境变量：',
        '  AGENTMAKE_PORT       调试器端口，默认 8787',
        '  AGENTMAKE_DB         数据库路径',
        '  AGENTMAKE_URL        探针 / MCP 连哪个调试器，默认 http://127.0.0.1:8787',
        '  AGENTMAKE_CHILDREN=0 被调试进程拉起的子进程不带探针（默认带，并挂在父运行下面）',
        '  AGENTMAKE=0          在被调试进程里彻底关掉探针',
      ].join('\n'),
    );
    break;

  default:
    console.error(`不认识的命令：${cmd}\n用 agentmake --help 看用法`);
    process.exit(2);
}
