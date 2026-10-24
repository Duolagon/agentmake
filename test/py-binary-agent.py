# 二进制响应透传：探针在不在，用户代码拿到的字节都必须一模一样。
import hashlib
import json
import os
import urllib.request

MOCK = f"http://127.0.0.1:{os.environ.get('MOCK_PORT', '8799')}"
out = {}

with urllib.request.urlopen(f"{MOCK}/bin/urllib") as r:
    b = r.read()
    out["urllib"] = [len(b), hashlib.sha256(b).hexdigest()]

try:
    import requests  # noqa: E402

    b = requests.get(f"{MOCK}/bin/requests").content
    out["requests"] = [len(b), hashlib.sha256(b).hexdigest()]
except ImportError:
    pass

print("RESULT " + json.dumps(out, sort_keys=True))
