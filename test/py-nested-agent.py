"""有函数层级的 Python agent：一个编排函数分出两条支路，一条抓数据、一条调模型。

用来验证调用栈推导出的执行图 —— 这是代理层做不到、harness 才有的能力。
"""
import json
import os
import urllib.request

MOCK = "http://127.0.0.1:%s" % os.environ.get("MOCK_PORT", "8799")


def http_get(path):
    with urllib.request.urlopen(MOCK + path, timeout=60) as r:
        return r.read().decode()


def scout_one(i):
    return http_get("/feed/%d" % i)


def gather():
    return [scout_one(i) for i in (1, 2, 3)]


def call_model(prompt):
    body = json.dumps(
        {"model": "deepseek-chat", "messages": [
            {"role": "system", "content": "你是摘要助手"},
            {"role": "user", "content": prompt}]}
    ).encode()
    req = urllib.request.Request(
        MOCK + "/v1/chat/completions", data=body, headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=600) as r:
        return json.loads(r.read())["choices"][0]["message"]["content"]


def compose(items):
    body = "\n".join("[%d] 材料内容：%s" % (i + 1, "内容" * 60) for i in range(len(items)))
    return call_model("总结以下 %d 条材料，输出三句话：\n%s" % (len(items), body))


def orchestrate():
    return compose(gather())


print("result:", orchestrate())
print("nested-done")
