// 工单 agent（常驻服务）—— 架构文档里那个典型 bug 的可运行版本。
//
//   POST /tickets { id, body }
//     1. load_history  拉这张工单的 12 条历史（工具调用）
//     2. analyze       判断优先级 —— ★ bug：只取了最后 5 条历史，带「投诉」「律师」的那两条被丢掉
//                      （FULL_HISTORY=1 是修好之后的版本：全部历史都进 prompt）
//     3. polish        循环润色 3 轮，每轮把上一轮的稿子塞回去 —— prompt 越滚越大
//     4. auto_reply    max_tokens 给得太小 —— 回答被截断
//        escalate      priority=urgent 时改走这条：转人工（被丢掉的历史里才有「投诉」，所以有 bug 时它几乎走不到）
//
// 每一步单独一个函数：数据流图的「步骤」按调用点区分，这样图上就是四个有名字的节点。
import http from 'node:http';

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

async function chat(body) {
  const r = await fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-chat', ...body }),
  });
  return (await r.json()).choices[0].message.content;
}

async function loadHistory(id) {
  return fetch(`${MOCK}/history/${id}`).then((r) => r.json());
}

async function analyze(history, ticket) {
  const msgs = [
    ...(process.env.FULL_HISTORY ? history : history.slice(-5)).map((h) => ({ role: h.role === 'agent' ? 'assistant' : 'user', content: h.content })),
    { role: 'user', content: ticket },
  ];
  return chat({ messages: [{ role: 'system', content: '你是工单分析助手。根据对话历史判断优先级，只输出 JSON。' }, ...msgs] });
}

async function polish(draft) {
  let text = draft;
  for (let round = 1; round <= Number(process.env.ROUNDS ?? 3); round++) {
    text = await chat({
      messages: [
        { role: 'system', content: '润色这段客服回复，保持礼貌。' },
        { role: 'user', content: `第 ${round} 轮，上一稿：${text}\n${text}` },
      ],
    });
  }
  return text;
}

async function escalate(ticket) {
  return chat({ messages: [{ role: 'system', content: '把这张工单转给值班主管，写一句交接说明。' }, { role: 'user', content: ticket }] });
}

async function autoReply(text) {
  return chat({ max_tokens: Number(process.env.REPLY_TOKENS ?? 3), messages: [{ role: 'system', content: '写一段给客户的回复' }, { role: 'user', content: text }] });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/quit') {
    res.end('bye');
    server.close();
    server.closeAllConnections?.();
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/tickets')) {
    res.statusCode = 404;
    return res.end();
  }
  let raw = '';
  for await (const c of req) raw += c;
  const { id, body } = JSON.parse(raw || '{}');
  const history = await loadHistory(id);
  const priority = await analyze(history, body);
  let reply;
  if (/urgent/.test(priority)) reply = await escalate(body);
  else reply = await autoReply(await polish(priority));
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ priority, reply }));
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => console.log(`PORT=${server.address().port}`));
