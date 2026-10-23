"""httpx 路径的固定件 —— openai / anthropic / google-genai 的 SDK 都走它。
同步和异步各跑一次。"""
import asyncio, json, os, httpx

MOCK = "http://127.0.0.1:%s" % os.environ.get("MOCK_PORT", "8799")
BODY = lambda p: {"model": "gpt-4o", "messages": [
    {"role": "system", "content": "你是 httpx 测试助手"},
    {"role": "user", "content": p}]}

def ask_sync(prompt):
    with httpx.Client(timeout=600) as c:
        r = c.post(MOCK + "/v1/chat/completions", json=BODY(prompt))
        return r.json()["choices"][0]["message"]["content"]

async def ask_async(prompt):
    async with httpx.AsyncClient(timeout=600) as c:
        r = await c.post(MOCK + "/v1/chat/completions", json=BODY(prompt))
        return r.json()["choices"][0]["message"]["content"]

async def fan_out():
    # 并发三条 —— 验证异步路径下钩子不会把事件循环冻住
    return await asyncio.gather(*[ask_async("并发 %d" % i) for i in range(3)])

def main():
    print("sync:", ask_sync("同步"))
    print("async:", asyncio.run(fan_out()))
    print("httpx-done")

main()
