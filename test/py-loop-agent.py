"""典型的手写 Python agent 循环：起草 → 评审 → 修订，源码里写死最多 N 轮。

代码里一个字都不知道 AgentMake 的存在。
"""
import json
import os
import urllib.request

MOCK = "http://127.0.0.1:%s" % os.environ.get("MOCK_PORT", "8799")
MAX = int(os.environ.get("LOOP_MAX", "5"))
DELAY = float(os.environ.get("LOOP_DELAY", "0")) / 1000.0


def call_model(prompt):
    body = json.dumps({"model": "m", "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(
        MOCK + "/v1/chat/completions", data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def refine():
    rounds = 0
    for i in range(MAX):
        call_model("第 %d 轮评审" % (i + 1))
        rounds += 1
        if DELAY:
            import time
            time.sleep(DELAY)
    return rounds


print("rounds=%d" % refine())
