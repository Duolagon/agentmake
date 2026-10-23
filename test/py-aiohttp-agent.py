"""aiohttp 与 httpx 流式的 agent —— 验证 Python 侧「不管怎么调模型，都看得见」。

  aiohttp：async with 普通调用 / 按行读流 / 调一个工具
  官方 openai SDK（底层 httpx）：同步 + 异步，普通 + 流式（stream=True 以前是完全放行、看不见的）

最后一行打印用户代码实际拿到的东西 —— e2e 拿它和重放那一次比。
"""
import asyncio
import json
import os

import aiohttp
import openai

MOCK = "http://127.0.0.1:%s" % os.environ.get("MOCK_PORT", "8799")
MSGS = [{"role": "system", "content": "你是 Python 客户端"}, {"role": "user", "content": "打个招呼"}]


def deltas(lines):
    s = ""
    for line in lines:
        line = line.strip()
        if not line.startswith("data:") or line.endswith("[DONE]"):
            continue
        j = json.loads(line[5:])
        s += ((j.get("choices") or [{}])[0].get("delta") or {}).get("content") or ""
    return s


async def main():
    out = {}
    async with aiohttp.ClientSession() as session:
        async with session.post(MOCK + "/v1/chat/completions", json={"model": "m", "messages": MSGS}) as r:
            out["aiohttp"] = (await r.json())["choices"][0]["message"]["content"]
        async with session.post(MOCK + "/v1/chat/completions", json={"model": "m", "stream": True, "messages": MSGS + [{"role": "user", "content": "stream"}]}) as r:
            lines = [line.decode() async for line in r.content]
            out["aiohttpStream"] = deltas(lines)
        async with session.get(MOCK + "/feed/aio") as r:
            out["aiohttpTool"] = await r.text()

    sync = openai.OpenAI(api_key="sk-test", base_url=MOCK + "/v1")
    out["sdk"] = sync.chat.completions.create(model="m", messages=MSGS + [{"role": "user", "content": "sdk"}]).choices[0].message.content
    out["sdkStream"] = "".join(c.choices[0].delta.content or "" for c in sync.chat.completions.create(
        model="m", stream=True, messages=MSGS + [{"role": "user", "content": "sdk stream"}]) if c.choices)

    aclient = openai.AsyncOpenAI(api_key="sk-test", base_url=MOCK + "/v1")
    s = ""
    async for c in await aclient.chat.completions.create(model="m", stream=True, messages=MSGS + [{"role": "user", "content": "async stream"}]):
        if c.choices:
            s += c.choices[0].delta.content or ""
    out["asyncSdkStream"] = s

    print("RESULT " + json.dumps(out, ensure_ascii=False))
    print("py-aiohttp-done")


asyncio.run(main())
