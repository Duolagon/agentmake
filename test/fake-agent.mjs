// 模拟一个手写 agent：裸 fetch 调三家协议，外加一次非 LLM 的 HTTP 请求和一次失败调用。
// 这个文件完全不知道 agentmake 的存在 —— 这正是要验证的：零侵入。

const MOCK = `http://127.0.0.1:${process.env.MOCK_PORT || 8799}`;

// 1) Gemini：系统提示在独立字段，模型名在 URL 里，助手角色叫 model
async function callGemini(topic) {
  const res = await fetch(`${MOCK}/v1beta/models/gemini-2.5-pro:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': 'AIza-SECRET-should-never-appear' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: '你是一个新闻分析助手。输出必须是中文，且不超过三句话。' }] },
      contents: [
        { role: 'user', parts: [{ text: `请分析这条新闻：${topic}` }] },
        { role: 'model', parts: [{ text: '好的，我需要更多上下文。' }] },
        { role: 'user', parts: [{ text: '就按你已有的信息分析。' }] },
      ],
      tools: [{ functionDeclarations: [{ name: 'search_web', description: '联网检索', parameters: { type: 'object' } }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    }),
  });
  return res.json();
}

// 2) Anthropic：顶层 system，content 是 block 数组
async function callClaude() {
  const res = await fetch(`${MOCK}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-SECRET' },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      system: '你是严谨的事实核查员。',
      max_tokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: '这段陈述可信吗？' }] }],
    }),
  });
  return res.json();
}

// 3) OpenAI 兼容：system 混在 messages 里
async function callOpenAI() {
  const res = await fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-SECRET' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你负责给新闻打分，输出 JSON。' },
        { role: 'user', content: '标题：某公司发布新产品' },
      ],
      temperature: 0.2,
      response_format: { type: 'json_object' },
    }),
  });
  return res.json();
}

// 4) 非 LLM 的普通请求 —— 应当被忽略，不出现在监视屏里
async function fetchRss() {
  return fetch(`${MOCK}/some/rss/feed`).catch(() => null);
}

// 5) 失败的 LLM 调用 —— 错误路径也要被观测到
async function callBroken() {
  return fetch(`${MOCK}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'this-is-not-json{{{',
  }).catch(() => null);
}

const r1 = await callGemini('某地发生 5.2 级地震，暂无人员伤亡报告');
console.log('gemini →', r1.candidates?.[0]?.content?.parts?.[0]?.text);
const r2 = await callClaude();
console.log('claude →', r2.content?.[0]?.text);
const r3 = await callOpenAI();
console.log('openai →', r3.choices?.[0]?.message?.content);
await fetchRss();
await callBroken();
console.log('done');
