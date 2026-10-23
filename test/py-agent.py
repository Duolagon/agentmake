#!/usr/bin/env python3
"""固定件：一个**纯 Python**的 agent，用来证明代理层真的不挑语言。

代码里一个字都不知道 AgentMake 的存在 —— 只认 OPENAI_BASE_URL 这个
业界通用的环境变量，和真实项目里的写法一致。
"""
import json
import os
import urllib.request

BASE = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
RUN = os.environ.get("AGENTMAKE_RUN")


def call_model(system, user):
    body = json.dumps({
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }).encode()
    headers = {"content-type": "application/json", "authorization": "Bearer sk-fake"}
    if RUN:
        headers["x-agentmake-run"] = RUN
    req = urllib.request.Request(f"{BASE}/chat/completions", data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def main():
    draft = call_model("你是选题助手", "给我一个选题")
    print("draft:", draft)
    review = call_model("你是审稿人", f"评审这个选题：{draft}")
    print("review:", review)
    print("py-done")


if __name__ == "__main__":
    main()
