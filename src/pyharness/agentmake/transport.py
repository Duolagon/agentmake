"""事件上报与钩子调用。

三条铁律（这段代码跑在用户进程里，任何差错都是我们的锅）：
  1. 事件上报绝不阻塞用户代码 —— 入队即返回，后台线程批量发送
  2. 绝不抛异常 —— 所有错误吞掉
  3. 服务端不在就静默放弃 —— 不重试风暴、不打日志刷屏

钩子调用（/api/hook/*）是**故意同步阻塞**的：命中断点时服务端把响应悬住，
用户进程就停在那里 —— 这正是断点该有的行为。
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import urlparse

# ⚠️ 在任何补丁生效之前抓住原始类。上报自身绝不能被自己的拦截器捕获，
# 否则每上报一次就产生一次新的调用，无限递归。
# 我们打补丁的位置是 httpx.Client.send / requests.Session.send /
# urllib OpenerDirector.open —— 都在 http.client 之上，所以这里直连底层是安全的。
import http.client as _http_client

_HTTPConnection = _http_client.HTTPConnection

ENDPOINT = (os.environ.get("AGENTMAKE_URL") or "http://127.0.0.1:8787").rstrip("/")
_parsed = urlparse(ENDPOINT)
_HOST = _parsed.hostname or "127.0.0.1"
_PORT = _parsed.port or 80
_BASE_PATH = _parsed.path.rstrip("/")

FLUSH_S = 0.12
MAX_QUEUE = 2000

_disabled = False
_queue: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=MAX_QUEUE)
_worker: Optional[threading.Thread] = None
_stop = threading.Event()
_http_armed = False
_lock = threading.Lock()


def disabled() -> bool:
    return _disabled


def http_armed() -> bool:
    return _http_armed


def _request(method: str, path: str, payload: Optional[dict], timeout: float) -> Optional[dict]:
    """一次同步 HTTP 往返。失败返回 None，永不抛。"""
    global _disabled
    if _disabled:
        return None
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    conn = None
    try:
        conn = _HTTPConnection(_HOST, _PORT, timeout=timeout)
        headers = {"content-type": "application/json"} if body is not None else {}
        conn.request(method, _BASE_PATH + path, body=body, headers=headers)
        resp = conn.getresponse()
        raw = resp.read()
        if resp.status >= 400:
            return None
        return json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:  # noqa: BLE001
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


def hook(path: str, payload: dict, timeout: float = 600.0) -> Optional[dict]:
    """调用 /api/hook/*。

    timeout 默认 10 分钟：命中断点时服务端会把响应悬住，等的是**人**做决定，
    按网络超时来设会把断点变成"停一会儿就自己跑了"。
    """
    return _request("POST", path, payload, timeout)


def emit(ev: Dict[str, Any]) -> None:
    """入队一条事件，立即返回。"""
    if _disabled:
        return
    try:
        _queue.put_nowait(ev)
    except queue.Full:
        # 宁可丢事件也不能把用户进程的内存吃光
        try:
            _queue.get_nowait()
            _queue.put_nowait(ev)
        except Exception:  # noqa: BLE001
            pass
    _ensure_worker()


def _ensure_worker() -> None:
    global _worker
    with _lock:
        if _worker is not None and _worker.is_alive():
            return
        # daemon：待发送的事件不该阻止用户进程退出。真正的排空交给 atexit 的 drain()
        _worker = threading.Thread(target=_loop, name="agentmake-transport", daemon=True)
        _worker.start()


def _loop() -> None:
    while not _stop.is_set():
        time.sleep(FLUSH_S)
        _flush()


def _flush() -> None:
    global _disabled, _http_armed
    batch = []
    while True:
        try:
            batch.append(_queue.get_nowait())
        except queue.Empty:
            break
    if not batch:
        return
    res = _request("POST", "/ingest", {"events": batch}, timeout=2.0)
    if res is None:
        # 服务端没起来 / 连不上：静默关闭，不再尝试，不影响用户程序
        _disabled = True
        while True:
            try:
                _queue.get_nowait()
            except queue.Empty:
                break
        return
    if isinstance(res.get("httpArmed"), bool):
        _http_armed = res["httpArmed"]


def prime_http_armed() -> None:
    """预取「工具断点开着吗」。

    平时这个值由 /ingest 的响应捎回来，但**短命进程的第一个动作可能就是 HTTP 调用**，
    那时还没发生过任何上报往返，缓存值必然是错的 False。所以安装时先取一次。
    """
    global _http_armed
    res = _request("GET", "/api/breakpoints", None, timeout=1.5)
    if res:
        _http_armed = bool(res.get("httpBefore") or res.get("httpAfter"))


def drain() -> None:
    """进程退出前把队列排空，否则最后几条事件会丢。"""
    if _disabled:
        return
    _stop.set()
    _flush()
