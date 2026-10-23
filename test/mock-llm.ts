// 假的 LLM 端点，三家协议各返回对应形状的响应。
// 用来在不烧真实 API 额度、不需要密钥的情况下验证拦截与归一化。
import http from 'node:http';
import zlib from 'node:zlib';

/** 一段 SSE：events 里每项是 [event 名或 null, data 对象 | 字符串] */
function sse(res: http.ServerResponse, events: [string | null, unknown][]): void {
  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  for (const [ev, data] of events) {
    res.write(`${ev ? `event: ${ev}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`);
  }
  res.end();
}

const STREAM_TEXT = ['流式回答', '第二段，', '结束。'];

const PORT = Number(process.env.MOCK_PORT || 8799);

/** 记下最近一次收到的请求体，供端到端断言「改动真的发到了模型」 */
let lastBody: unknown = null;
/** 调用计数 —— 重放测试要证明的是「模型根本没被调用」，只能靠上游自己数 */
const count = { llm: 0, http: 0 };

http
  .createServer(async (req, res) => {
    if (req.url === '/__last') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(lastBody));
    }
    if (req.url === '/__count') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(count));
    }
    if (req.url === '/__reset') {
      count.llm = 0;
      count.http = 0;
      lastBody = null;
      res.setHeader('content-type', 'application/json');
      return res.end('{"ok":true}');
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8') || '{}';
    let body: any = {};
    try {
      body = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ error: { message: 'invalid JSON body' } }));
    }
    const p = req.url ?? '';
    lastBody = body;
    if (/:generateContent|\/messages$|\/chat\/completions$/.test(p)) count.llm++;

    // x-mock-gzip: 1 → 响应用 gzip 压缩（axios 默认要 gzip，node:http 拦截那边得能解开）
    if (req.headers['x-mock-gzip'] === '1') {
      const end = res.end.bind(res) as (b?: unknown) => http.ServerResponse;
      res.end = ((b?: unknown) => {
        if (res.headersSent) return end(b);
        res.setHeader('content-encoding', 'gzip');
        return end(zlib.gzipSync(Buffer.from(typeof b === 'string' ? b : (b as Buffer) ?? '')));
      }) as never;
    }
    const path = new URL(p, 'http://x').pathname;

    // ── 流式 ──
    if (/:streamGenerateContent$/.test(path)) {
      count.llm++;
      return sse(res, STREAM_TEXT.map((t, i) => [null, {
        candidates: [{ content: { role: 'model', parts: [{ text: `[gemini]${t}` }] }, ...(i === STREAM_TEXT.length - 1 ? { finishReason: 'STOP' } : {}) }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 9 },
      }]));
    }
    if (path.endsWith('/chat/completions') && body?.stream) {
      const chunk = (delta: unknown, finish: string | null = null) => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
      if (body?.tools?.length) {
        return sse(res, [
          [null, chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_s1', type: 'function', function: { name: body.tools[0].function.name, arguments: '' } }] })],
          [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"q":' } }] })],
          [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '"订单"}' } }] })],
          [null, chunk({}, 'tool_calls')],
          [null, '[DONE]'],
        ]);
      }
      return sse(res, [
        [null, chunk({ role: 'assistant', content: '' })],
        ...STREAM_TEXT.map((t) => [null, chunk({ content: `[openai]${t}` })] as [null, unknown]),
        [null, chunk({}, body?.max_tokens && body.max_tokens <= 5 ? 'length' : 'stop')],
        [null, { choices: [], usage: { prompt_tokens: 40, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 0 } } }],
        [null, '[DONE]'],
      ]);
    }
    if (path.endsWith('/messages') && body?.stream) {
      return sse(res, [
        ['message_start', { type: 'message_start', message: { id: 'msg_s', role: 'assistant', usage: { input_tokens: 60, output_tokens: 1 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ...STREAM_TEXT.map((t) => ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `[anthropic]${t}` } }] as [string, unknown]),
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }

    // ── OpenAI Responses API ──
    if (/\/responses$/.test(path)) {
      count.llm++;
      const input = typeof body?.input === 'string' ? [{ role: 'user', content: body.input }] : (body?.input ?? []);
      const hasResult = input.some((x: any) => x?.type === 'function_call_output');
      const output = body?.tools?.length && !hasResult
        ? [{ type: 'function_call', id: 'fc_1', call_id: 'call_r1', name: body.tools[0].name, arguments: '{"city":"北京"}', status: 'completed' }]
        : [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `[responses] ${hasResult ? '根据工具结果：晴' : '你好'}`, annotations: [] }] }];
      const incomplete = body?.max_output_tokens && body.max_output_tokens <= 5;
      const resp = {
        id: 'resp_1', object: 'response', model: body?.model ?? 'gpt-x', status: incomplete ? 'incomplete' : 'completed',
        ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        output, usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90, input_tokens_details: { cached_tokens: 0 } },
      };
      if (body?.stream) {
        const text = (output[0] as any).content?.[0]?.text ?? '';
        return sse(res, [
          ['response.created', { type: 'response.created', response: { ...resp, status: 'in_progress', output: [] } }],
          ...[text.slice(0, 6), text.slice(6)].map((d) => ['response.output_text.delta', { type: 'response.output_text.delta', delta: d }] as [string, unknown]),
          ['response.completed', { type: 'response.completed', response: resp }],
        ]);
      }
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(resp));
    }
    else count.http++;

    res.setHeader('content-type', 'application/json');

    if (/:generateContent/.test(p)) {
      const userText = body?.contents?.at(-1)?.parts?.map((x: any) => x.text).join('') ?? '';
      return res.end(
        JSON.stringify({
          candidates: [
            { content: { role: 'model', parts: [{ text: `[gemini] 收到：${userText.slice(0, 40)}` }] }, finishReason: 'STOP' },
          ],
          usageMetadata: { promptTokenCount: 1234, candidatesTokenCount: 56, cachedContentTokenCount: 900 },
        }),
      );
    }

    if (p.endsWith('/messages')) {
      return res.end(
        JSON.stringify({
          content: [{ type: 'text', text: '[anthropic] 好的。' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 2222, output_tokens: 33, cache_read_input_tokens: 2000 },
        }),
      );
    }

    if (p.endsWith('/chat/completions')) {
      // 带了 tools、且最后一条还不是工具结果 → 模拟模型「先调工具」。
      // 只有工具调用、没有正文（content: null），这正是文本视图看不见的那种回答
      const msgs = body?.messages ?? [];
      const last = msgs.at(-1);
      if (body?.tools?.length && last?.role !== 'tool') {
        const name = body.tools[0]?.function?.name ?? 'tool';
        const q = String(last?.content ?? '').slice(0, 20);
        return res.end(
          JSON.stringify({
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  // id 每次都不一样，和真模型一样 —— 重放指纹不能依赖它
                  id: `call_${Math.random().toString(36).slice(2, 10)}`,
                  type: 'function',
                  function: { name, arguments: JSON.stringify({ q }) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
            usage: { prompt_tokens: 300, completion_tokens: 20 },
          }),
        );
      }
      // max_tokens 给得太小 → 模拟被截断：HTTP 200、有半截内容、finish_reason=length。
      // 日志里这是「成功」，规则判定要把它找出来
      if (typeof body?.max_tokens === 'number' && body.max_tokens <= 5) {
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: '优先级：' }, finish_reason: 'length' }],
            usage: { prompt_tokens: 200, completion_tokens: body.max_tokens },
          }),
        );
      }
      // 判优先级的模型：像真模型一样看内容 —— 看见「投诉」「律师」就是 urgent
      const sys = String(msgs.find((m: any) => m.role === 'system')?.content ?? '');
      if (sys.includes('优先级')) {
        const all = msgs.map((m: any) => String(m.content ?? '')).join('\n');
        const urgent = /投诉|律师/.test(all);
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ priority: urgent ? 'urgent' : 'normal' }) }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100 + all.length, completion_tokens: 8 },
          }),
        );
      }
      if (last?.role === 'tool') {
        return res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: `[openai] 根据工具结果：${String(last.content).slice(0, 40)}` }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 400, completion_tokens: 15 },
          }),
        );
      }
      return res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '[openai] 明白了。' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 777, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 500 } },
        }),
      );
    }

    // 工单历史：固定 12 条 JSON 列表。第 2、5 条带着「投诉」「律师」—— 只取最后 5 条的代码会把它们丢掉
    if (req.method === 'GET' && p.startsWith('/history/')) {
      const lines = [
        '您好，订单 42 显示已发货但一直没有物流更新',
        '上周就说过了，再不处理我要投诉到消费者协会',
        '客服您好，请问能帮我查一下物流吗',
        '已经三天了还是没有任何消息，非常失望',
        '我已经联系了律师，准备走法律程序处理这件事',
        '能不能先给我一个明确的到货时间',
        '你们的客服电话一直打不通',
        '收到您的反馈，我们正在核实物流信息',
        '已为您加急处理，请耐心等待',
        '好的，那大概什么时候能到呢',
        '预计两到三个工作日内送达',
        '订单 42 到底什么时候能到，请给个准话',
      ];
      // id 尾数为 0 的工单只有前 4 条历史 —— slice(-5) 丢不掉东西，是对照组
      const id = Number(p.split('/').pop());
      const kept = id % 10 === 0 ? lines.slice(0, 4) : lines;
      return res.end(JSON.stringify(kept.map((content, i) => ({ id: i + 1, role: i % 3 === 2 ? 'agent' : 'customer', content }))));
    }

    // 非 LLM 的 GET 当成「工具/抓数据」成功返回 —— 固定件里的 /feed/N 走这里。
    // 早期一律 404，导致流程图上工具步骤永远是红的，看不出真实形态。
    if (req.method === 'GET') return res.end(`fixture payload for ${p}`);

    res.statusCode = 404;
    res.end(JSON.stringify({ error: { message: 'unknown endpoint' } }));
  })
  .listen(PORT, '127.0.0.1', () => console.log(`mock-llm → http://127.0.0.1:${PORT}`));
