// 常驻服务形态的被调试对象：一个 HTTP server，每个 POST /ask 先抓一份资料、再问一次模型。
// GET /health 什么调用都不发 —— 用来证明「不碰模型的请求不会冒出空运行」。
// POST /quit 关掉 server，进程自然退出（走 beforeExit，让上报队列发完）。
import http from 'node:http';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') return res.end('ok');
  if (req.url === '/quit') {
    res.end('bye');
    server.close();
    server.closeAllConnections?.();
    return;
  }
  if (req.method === 'POST' && req.url?.startsWith('/ask')) {
    let body = '';
    for await (const c of req) body += c;
    const { q } = JSON.parse(body || '{}');
    // 交错一下，让并发的两个请求在异步链上真的互相穿插
    await new Promise((r) => setTimeout(r, Math.random() * 30));
    const doc = await fetch(`${MOCK}/feed/${encodeURIComponent(q)}`).then((r) => r.text());
    const r = await fetch(`${MOCK}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: '根据资料回答' }, { role: 'user', content: `问题：${q}\n资料：${doc}` }],
      }),
    }).then((x) => x.json());
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ answer: r.choices[0].message.content }));
  }
  res.statusCode = 404;
  res.end('not found');
});

server.listen(0, '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
