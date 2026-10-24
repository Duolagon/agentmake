// MCP server（stdio）—— 把调试器的能力开放给 Claude Code / Cursor 这类 AI 编程助手。
//
// 手写 JSON-RPC 而不是引入 @modelcontextprotocol/sdk：MCP 的核心面很小
// （initialize / tools/list / tools/call / ping），而零依赖是这个项目的一项资产。
//
// ⚠️ stdout 只能有 JSON-RPC 消息，任何多余的输出都会破坏协议。日志一律走 stderr。

import { TOOLS } from './tools.ts';

type Req = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: any };

const log = (...a: unknown[]) => {
  if (process.env.AGENTMAKE_DEBUG) console.error('[agentmake-mcp]', ...a);
};

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const reply = (id: Req['id'], result: unknown) => send({ jsonrpc: '2.0', id, result });
const fail = (id: Req['id'], code: number, message: string) =>
  send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(req: Req): Promise<void> {
  switch (req.method) {
    case 'initialize':
      return reply(req.id, {
        // 回声客户端请求的版本，兼容性最好
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agentmake', version: '0.1.0' },
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // 通知没有 id，不能回复

    case 'ping':
      return reply(req.id, {});

    case 'tools/list':
      return reply(req.id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      });

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === req.params?.name);
      if (!tool) return fail(req.id, -32602, `未知工具: ${req.params?.name}`);
      try {
        const text = await tool.run(req.params?.arguments ?? {});
        return reply(req.id, { content: [{ type: 'text', text }] });
      } catch (e) {
        // 工具执行失败要作为 isError 结果回去，而不是协议级错误 ——
        // 这样 AI 能看到错误信息并自己调整，而不是整个调用链断掉
        return reply(req.id, {
          content: [{ type: 'text', text: `工具执行失败：${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      if (req.id === undefined) return; // 未知通知，忽略
      return fail(req.id, -32601, `未实现的方法: ${req.method}`);
  }
}

// ── stdio 读循环：MCP 用换行分隔的 JSON，不是 LSP 那种 Content-Length 头 ──

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl: number;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req: Req;
    try {
      req = JSON.parse(line);
    } catch {
      log('丢弃非 JSON 行:', line.slice(0, 80));
      continue;
    }
    // 合法 JSON 不一定是对象：null / 数字 / 数组（批量请求，没实现）都要按协议回错，不能把进程带崩
    if (!req || typeof req !== 'object' || Array.isArray(req) || typeof (req as Req).method !== 'string') {
      log('丢弃不是 JSON-RPC 请求的行:', line.slice(0, 80));
      fail(null, -32600, 'Invalid Request');
      continue;
    }
    handle(req).catch((e) => {
      log('handler 异常:', e);
      if (req.id !== undefined) fail(req.id, -32603, String(e?.message ?? e));
    });
  }
});

process.stdin.on('end', () => process.exit(0));
log('ready, 目标调试器:', process.env.AGENTMAKE_URL || 'http://127.0.0.1:8787');
