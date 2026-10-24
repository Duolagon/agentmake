"""拦截 Python 侧的 HTTP 出口。

为什么拦 HTTP 而不是 patch 各家 SDK：SDK 是开放集合（openai / anthropic /
google-genai / litellm / 自研封装…），枚举不完，版本还一直漂。而它们**最终都要
发一个 HTTP 请求**，把这一层拦住就一次覆盖全部。

拦三个口子，各自是对应生态的唯一咽喉：
  httpx.Client.send / AsyncClient.send   —— openai>=1.0、anthropic、google-genai 都走它
  requests.Session.send                  —— 老代码和大量手写 agent
  urllib.request.OpenerDirector.open     —— 标准库，零依赖脚本

协议识别、归一化、指纹、断点决策全部交给服务端的 /api/hook/*，这边只负责
「抓栈 + 拦 HTTP + 按指令行事」。见 src/server/hook.ts 里关于为什么这么切的说明。
"""

from __future__ import annotations

import atexit
import functools
import importlib
import importlib.abc
import importlib.util
import io
import os
import sys
import threading
import time
import uuid
from typing import Any, Callable, Optional, Tuple

from . import loops, stack, transport

RUN_ID = os.environ.get("AGENTMAKE_RUN_ID") or f"run_py{int(time.time() * 1000):x}_{uuid.uuid4().hex[:6]}"
REPLAY_BASELINE = os.environ.get("AGENTMAKE_REPLAY") or None

_seq = 0
_call_no = 0
_seq_lock = threading.Lock()

# 重入保护：钩子调用自己也走 HTTP。transport 直连 http.client 已经绕开了我们打的
# 补丁，但用户可能再套一层别的拦截 —— 多一道保险不亏。
_local = threading.local()

MAX_HTTP_CALLS = int(os.environ.get("AGENTMAKE_MAX_HTTP", "2000"))
_http_count = 0


def _ok(status: int) -> bool:
    """别用 httpx 的 resp.is_success —— 0.23 之前没这个属性，装了老版本就直接报错。"""
    return 200 <= status < 400


class AgentMakeAbort(RuntimeError):
    """断点上主动中止 —— 故意抛进用户代码，用来测它的错误分支。"""


def next_seq() -> int:
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


def _next_call_id() -> str:
    global _call_no
    with _seq_lock:
        _call_no += 1
        return f"call_{RUN_ID[4:]}_{_call_no}"


def _skip(url: str) -> bool:
    if transport.disabled():
        return True
    if getattr(_local, "busy", False):
        return True
    return stack.self_call(url)


# ── 一次调用的通用流程 ─────────────────────────────────────
#
# 三个适配器（httpx / requests / urllib）只在「怎么发」「怎么造响应」上不同，
# 决策流程完全一样，收敛到这里，免得同一段逻辑写三遍、错三处。


def _decide_before(
    url: str, method: str, body: Optional[bytes], headers: dict, frames: Optional[list] = None
) -> Tuple[str, dict]:
    # frames 允许外部传入：异步路径上钩子是丢到线程池里跑的，而**线程池里没有
    # 用户帧** —— 在那儿抓栈只会抓到 concurrent.futures 的内部实现，
    # 于是整条异步调用在执行图上退化成"没有调用栈"的代理模式。
    call_id = _next_call_id()
    if frames is None:
        frames = stack.capture_frames()
    payload = {
        "runId": RUN_ID,
        "callId": call_id,
        "seq": next_seq(),
        "url": url,
        "method": method,
        "body": body.decode("utf-8", "replace") if body else None,
        "headers": {k.lower(): v for k, v in headers.items()},
        "frames": frames,
        "replayBaseline": REPLAY_BASELINE,
    }
    _local.busy = True
    try:
        d = transport.hook("/api/hook/before", payload) or {"action": "continue"}
    finally:
        _local.busy = False
    return call_id, d


def _decide_after(
    call_id: str,
    status: int,
    ok: bool,
    duration_ms: int,
    text: Optional[str],
    error: Optional[str],
    passive: bool = False,
) -> dict:
    payload = {
        # 只旁听：响应已经交给用户代码了（流、aiohttp 的读取流），服务端只记录、不停在断点上
        "passive": passive,
        "runId": RUN_ID,
        "callId": call_id,
        "seq": next_seq(),
        "status": status,
        "ok": ok,
        "durationMs": duration_ms,
        "body": text,
        "error": error,
    }
    _local.busy = True
    try:
        return transport.hook("/api/hook/after", payload) or {"action": "continue"}
    finally:
        _local.busy = False


def run_call(
    url: str,
    method: str,
    body: Optional[bytes],
    headers: dict,
    do_send: Callable[[str, Optional[bytes]], Tuple[int, bool, Optional[str], Any]],
    build_response: Callable[[int, str, Any], Any],
) -> Any:
    """拦截一次调用的完整流程。

    do_send(url, body) -> (status, ok, text, native_response)
    build_response(status, text, native_or_None) -> 交还给用户代码的响应对象
    """
    global _http_count
    _http_count += 1
    if _http_count > MAX_HTTP_CALLS:
        # 超了上限只透传：交回原生响应，不经 build_response —— 后者按文本重建，二进制会被改坏
        return do_send(url, body)[3]

    call_id, d = _decide_before(url, method, body, headers)
    action = d.get("action")

    if action == "abort":
        raise AgentMakeAbort(d.get("message") or "aborted by agentmake")

    if action == "fake":
        r = d.get("response") or {}
        # 伪造/重放：模型压根没被调用，直接把这个响应交回去
        return build_response(int(r.get("status", 200)), r.get("body") or "", None)

    send_url, send_body = url, body
    if action == "patch":
        # 断点里改了 prompt —— 发出去的是改过的那一份
        if d.get("url"):
            send_url = d["url"]
        if d.get("body") is not None:
            send_body = d["body"].encode("utf-8")

    started = time.time()
    try:
        status, ok, text, native = do_send(send_url, send_body)
    except Exception as e:  # noqa: BLE001
        _decide_after(call_id, 0, False, int((time.time() - started) * 1000), None, str(e))
        raise

    after = _decide_after(call_id, status, ok, int((time.time() - started) * 1000), text, None)
    if after.get("action") == "abort":
        raise AgentMakeAbort(after.get("message") or "aborted by agentmake")
    if after.get("action") == "replace":
        r = after.get("response") or {}
        return build_response(int(r.get("status", status)), r.get("body") or "", native)
    return native


# ── httpx ──────────────────────────────────────────────────


def _patch_httpx(httpx) -> None:
    if getattr(httpx, "_agentmake_patched", False):
        return
    httpx._agentmake_patched = True

    def _headers_without_length(h):
        return {k: v for k, v in h.items() if k.lower() not in ("content-length", "content-encoding")}

    def _rebuild(request, url, body):
        if url == str(request.url) and body is request.content:
            return request
        return httpx.Request(
            request.method,
            url,
            headers=_headers_without_length(request.headers),
            content=body,
        )

    orig_send = httpx.Client.send

    @functools.wraps(orig_send)
    def send(self, request, **kw):
        url = str(request.url)
        if _skip(url):
            return orig_send(self, request, **kw)
        # stream=True（openai / anthropic SDK 的流式调用都走这条）：响应体是懒读的，
        # 不能先读掉 —— 换成旁听的流，用户读到底时再上报
        if kw.get("stream"):
            return _httpx_streamed(httpx, request, url, kw, lambda r: orig_send(self, r, **kw), _rebuild)

        def do_send(u, b):
            resp = orig_send(self, _rebuild(request, u, b), **kw)
            resp.read()
            return resp.status_code, _ok(resp.status_code), resp.text, resp

        def build(status, text, native):
            return httpx.Response(
                status,
                content=text.encode("utf-8"),
                headers=_headers_without_length(native.headers) if native is not None
                else {"content-type": "application/json"},
                request=request,
            )

        return run_call(url, request.method, request.content, dict(request.headers), do_send, build)

    httpx.Client.send = send

    orig_asend = httpx.AsyncClient.send

    @functools.wraps(orig_asend)
    async def asend(self, request, **kw):
        url = str(request.url)
        if _skip(url):
            return await orig_asend(self, request, **kw)

        import asyncio

        if kw.get("stream"):
            return await _httpx_astreamed(httpx, request, url, kw, lambda r: orig_asend(self, r, **kw), _rebuild)

        loop = asyncio.get_running_loop()
        holder: dict = {}

        # 钩子调用是阻塞的（断点要把这次调用悬住）。在协程里直接阻塞会把整个
        # 事件循环冻住 —— 一个协程停在断点上，其它并发的协程也全部卡死。
        # 丢到线程里 await，才对得上 Node 侧「停一个不影响其它并发」的语义。
        async def hook_in_thread(fn, *a):
            return await loop.run_in_executor(None, lambda: fn(*a))

        # 先在协程自己的栈上抓帧，再丢进线程池
        frames = stack.capture_frames()
        call_id, d = await hook_in_thread(
            _decide_before, url, request.method, request.content, dict(request.headers), frames
        )
        action = d.get("action")
        if action == "abort":
            raise AgentMakeAbort(d.get("message") or "aborted by agentmake")
        if action == "fake":
            r = d.get("response") or {}
            return httpx.Response(
                int(r.get("status", 200)),
                content=(r.get("body") or "").encode("utf-8"),
                headers={"content-type": "application/json"},
                request=request,
            )

        send_url, send_body = url, request.content
        if action == "patch":
            if d.get("url"):
                send_url = d["url"]
            if d.get("body") is not None:
                send_body = d["body"].encode("utf-8")

        started = time.time()
        try:
            resp = await orig_asend(self, _rebuild(request, send_url, send_body), **kw)
            await resp.aread()
        except Exception as e:  # noqa: BLE001
            await hook_in_thread(
                _decide_after, call_id, 0, False, int((time.time() - started) * 1000), None, str(e)
            )
            raise

        after = await hook_in_thread(
            _decide_after,
            call_id,
            resp.status_code,
            _ok(resp.status_code),
            int((time.time() - started) * 1000),
            resp.text,
            None,
        )
        if after.get("action") == "abort":
            raise AgentMakeAbort(after.get("message") or "aborted by agentmake")
        if after.get("action") == "replace":
            r = after.get("response") or {}
            holder["r"] = httpx.Response(
                int(r.get("status", resp.status_code)),
                content=(r.get("body") or "").encode("utf-8"),
                headers=_headers_without_length(resp.headers),
                request=request,
            )
            return holder["r"]
        return resp

    httpx.AsyncClient.send = asend


# ── 流式与旁听 ─────────────────────────────────────────────
#
# 响应已经要交给用户代码去读了（httpx 的 stream=True、aiohttp 的读取流）：不能先读掉，
# 换成一个「边读边记」的包装，读到底（或用户提前关掉）时把记下的内容补报上去 —— 只记录，不阻塞。

_BODY_CAP = int(os.environ.get("AGENTMAKE_BODY_BYTES", str(256 * 1024)))


def _decode(raw: bytes, encoding: Optional[str]) -> str:
    """httpx 的 .stream 给的是原始字节（可能还压缩着）—— 只为我们自己看而解开"""
    enc = (encoding or "").lower()
    try:
        if "gzip" in enc:
            import zlib

            raw = zlib.decompress(raw, 16 + zlib.MAX_WBITS)
        elif "deflate" in enc:
            import zlib

            raw = zlib.decompress(raw)
        elif "br" in enc:
            import brotli  # type: ignore

            raw = brotli.decompress(raw)
    except Exception:  # noqa: BLE001
        pass
    return raw.decode("utf-8", "replace")


class _Recorder:
    """记下流过的字节（有上限），只触发一次完成回调"""

    def __init__(self, done: Callable[[bytes], None]):
        self.buf = bytearray()
        self.done = done
        self.fired = False

    def feed(self, chunk) -> None:
        if chunk and len(self.buf) < _BODY_CAP:
            self.buf.extend(bytes(chunk)[: _BODY_CAP - len(self.buf)])

    def finish(self) -> None:
        if self.fired:
            return
        self.fired = True
        try:
            self.done(bytes(self.buf))
        except Exception:  # noqa: BLE001
            pass


def _fake_from_decision(d: dict) -> Tuple[int, bytes, str]:
    r = d.get("response") or {}
    return int(r.get("status", 200)), (r.get("body") or "").encode("utf-8"), r.get("ctype") or "application/json"


def _apply_patch(d: dict, url: str, body: Optional[bytes]) -> Tuple[str, Optional[bytes]]:
    if d.get("action") != "patch":
        return url, body
    return d.get("url") or url, d["body"].encode("utf-8") if d.get("body") is not None else body


def _httpx_streamed(httpx, request, url, kw, send, rebuild):
    call_id, d = _decide_before(url, request.method, request.content, dict(request.headers))
    if d.get("action") == "abort":
        raise AgentMakeAbort(d.get("message") or "aborted by agentmake")
    if d.get("action") == "fake":
        status, body, ctype = _fake_from_decision(d)
        return httpx.Response(status, content=body, headers={"content-type": ctype}, request=request)
    send_url, send_body = _apply_patch(d, url, request.content)
    started = time.time()
    try:
        resp = send(rebuild(request, send_url, send_body))
    except Exception as e:  # noqa: BLE001
        _decide_after(call_id, 0, False, int((time.time() - started) * 1000), None, str(e), True)
        raise
    enc = resp.headers.get("content-encoding")
    rec = _Recorder(lambda raw: _decide_after(
        call_id, resp.status_code, _ok(resp.status_code), int((time.time() - started) * 1000), _decode(raw, enc), None, True))
    inner = resp.stream

    class _Tap(httpx.SyncByteStream):
        def __iter__(self):
            try:
                for chunk in inner:
                    rec.feed(chunk)
                    yield chunk
            finally:
                rec.finish()

        def close(self):
            try:
                inner.close()
            finally:
                rec.finish()

    resp.stream = _Tap()
    return resp


async def _httpx_astreamed(httpx, request, url, kw, send, rebuild):
    import asyncio

    loop = asyncio.get_running_loop()
    frames = stack.capture_frames()
    call_id, d = await loop.run_in_executor(
        None, lambda: _decide_before(url, request.method, request.content, dict(request.headers), frames))
    if d.get("action") == "abort":
        raise AgentMakeAbort(d.get("message") or "aborted by agentmake")
    if d.get("action") == "fake":
        status, body, ctype = _fake_from_decision(d)
        return httpx.Response(status, content=body, headers={"content-type": ctype}, request=request)
    send_url, send_body = _apply_patch(d, url, request.content)
    started = time.time()
    try:
        resp = await send(rebuild(request, send_url, send_body))
    except Exception as e:  # noqa: BLE001
        loop.run_in_executor(None, lambda: _decide_after(
            call_id, 0, False, int((time.time() - started) * 1000), None, str(e), True))
        raise
    enc = resp.headers.get("content-encoding")
    # 上报丢到线程里、不等它 —— 读完流的那一刻不能把事件循环卡住
    rec = _Recorder(lambda raw: loop.run_in_executor(None, lambda: _decide_after(
        call_id, resp.status_code, _ok(resp.status_code), int((time.time() - started) * 1000), _decode(raw, enc), None, True)))
    inner = resp.stream

    class _ATap(httpx.AsyncByteStream):
        async def __aiter__(self):
            try:
                async for chunk in inner:
                    rec.feed(chunk)
                    yield chunk
            finally:
                rec.finish()

        async def aclose(self):
            try:
                await inner.aclose()
            finally:
                rec.finish()

    resp.stream = _ATap()
    return resp


# ── aiohttp ────────────────────────────────────────────────
#
# 一部分异步 agent 不用 httpx，用 aiohttp。拦 ClientSession._request —— session.post / get /
# request 最后都到这里。调用前的事（断点改写、伪造、中止、重放）和别的口子一样；
# 调用后只旁听：把 resp.content 换成边读边记的包装 —— 用户用 json()、text()、按行读流都照旧。


class _TapReader:
    """包住 aiohttp 的 StreamReader：所有读法照常转发，顺手记一份，读到底时上报"""

    def __init__(self, inner, rec: _Recorder):
        self._inner = inner
        self._rec = rec

    def _got(self, data):
        self._rec.feed(data)
        if not data or self._inner.at_eof():
            self._rec.finish()
        return data

    async def read(self, n: int = -1):
        return self._got(await self._inner.read(n))

    async def readany(self):
        return self._got(await self._inner.readany())

    async def readline(self):
        return self._got(await self._inner.readline())

    async def readexactly(self, n: int):
        return self._got(await self._inner.readexactly(n))

    async def readchunk(self):
        data, end = await self._inner.readchunk()
        self._got(data)
        return data, end

    async def iter_chunked(self, n: int):
        while True:
            data = await self.read(n)
            if not data:
                return
            yield data

    async def iter_any(self):
        while True:
            data = await self.readany()
            if not data:
                return
            yield data

    async def iter_chunks(self):
        while True:
            data, end = await self.readchunk()
            if not data and not end:
                return
            yield data, end

    def __aiter__(self):
        return self._lines()

    async def _lines(self):
        while True:
            line = await self.readline()
            if not line:
                return
            yield line

    def __getattr__(self, name):
        return getattr(self._inner, name)


class _BytesReader:
    """伪造 / 重放的响应体 —— 支持和 StreamReader 一样的几种读法"""

    def __init__(self, data: bytes):
        self._data = data
        self._pos = 0

    def at_eof(self) -> bool:
        return self._pos >= len(self._data)

    async def read(self, n: int = -1):
        end = len(self._data) if n is None or n < 0 else min(len(self._data), self._pos + n)
        out, self._pos = self._data[self._pos:end], end
        return out

    async def readany(self):
        return await self.read()

    async def readline(self):
        i = self._data.find(b"\n", self._pos)
        end = len(self._data) if i < 0 else i + 1
        out, self._pos = self._data[self._pos:end], end
        return out

    async def readexactly(self, n: int):
        return await self.read(n)

    async def readchunk(self):
        data = await self.read()
        return data, self.at_eof()

    async def iter_chunked(self, n: int):
        while not self.at_eof():
            yield await self.read(n)

    async def iter_any(self):
        while not self.at_eof():
            yield await self.read()

    def __aiter__(self):
        return self._lines()

    async def _lines(self):
        while not self.at_eof():
            yield await self.readline()


def _fake_aiohttp_response(aiohttp, status: int, body: bytes, ctype: str, url: str, method: str):
    """伪造 / 重放命中时交给用户代码的响应 —— 和 ClientResponse 的常用接口对齐（async with、json、按行读流）"""
    from multidict import CIMultiDict, CIMultiDictProxy
    from yarl import URL
    import json as _json

    class _FakeResponse:
        def __init__(self):
            self.status = status
            self.reason = "OK" if status < 400 else "Error"
            self.method = method
            self.url = self.real_url = URL(url)
            self.headers = CIMultiDictProxy(CIMultiDict({"Content-Type": ctype, "Content-Length": str(len(body))}))
            self.content_type = ctype.split(";")[0].strip()
            self.charset = "utf-8"
            self.content = _BytesReader(body)
            self.history = ()
            self.closed = False
            self._body = body

        @property
        def ok(self):
            return self.status < 400

        async def read(self):
            return self._body

        async def text(self, encoding=None, errors="strict"):
            return self._body.decode(encoding or "utf-8", errors)

        async def json(self, *, encoding=None, loads=_json.loads, content_type="application/json"):
            return loads(self._body.decode(encoding or "utf-8"))

        def raise_for_status(self):
            if self.status >= 400:
                raise aiohttp.ClientResponseError(None, (), status=self.status, message=self.reason)  # type: ignore[arg-type]

        def release(self):
            pass

        def close(self):
            self.closed = True

        async def wait_for_close(self):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            self.release()

    return _FakeResponse()


def _patch_aiohttp(aiohttp) -> None:
    if getattr(aiohttp, "_agentmake_patched", False):
        return
    aiohttp._agentmake_patched = True
    import asyncio
    import json as _json

    orig = aiohttp.ClientSession._request

    @functools.wraps(orig)
    async def _request(self, method, str_or_url, **kw):
        url = str(str_or_url)
        try:
            if kw.get("params"):
                from yarl import URL

                url = str(URL(url).update_query(kw["params"]))
            if getattr(self, "_base_url", None) is not None and not url.startswith(("http://", "https://")):
                url = str(self._base_url.join(__import__("yarl").URL(url)))
        except Exception:  # noqa: BLE001
            pass
        if _skip(url):
            return await orig(self, method, str_or_url, **kw)

        # 请求体：json= / data=（bytes、str）认得；表单、文件流之类的不碰，原样放行
        if kw.get("json") is not None:
            body: Optional[bytes] = _json.dumps(kw["json"]).encode("utf-8")
        elif isinstance(kw.get("data"), (bytes, bytearray)):
            body = bytes(kw["data"])
        elif isinstance(kw.get("data"), str):
            body = kw["data"].encode("utf-8")
        elif kw.get("data") is None:
            body = None
        else:
            return await orig(self, method, str_or_url, **kw)

        headers = {**{k: v for k, v in (self.headers or {}).items()}, **dict(kw.get("headers") or {})}
        loop = asyncio.get_running_loop()
        frames = stack.capture_frames()
        call_id, d = await loop.run_in_executor(None, lambda: _decide_before(url, method, body, headers, frames))
        if d.get("action") == "abort":
            raise AgentMakeAbort(d.get("message") or "aborted by agentmake")
        if d.get("action") == "fake":
            status, fbody, ctype = _fake_from_decision(d)
            return _fake_aiohttp_response(aiohttp, status, fbody, ctype, url, method)

        send_url, send_body = _apply_patch(d, url, body)
        if send_body is not body:
            kw = dict(kw)
            hdrs = dict(kw.get("headers") or {})
            if kw.pop("json", None) is not None:
                hdrs.setdefault("Content-Type", "application/json")
            hdrs.pop("Content-Length", None)
            kw["headers"] = hdrs
            kw["data"] = send_body
        target = send_url if send_url != url else str_or_url

        started = time.time()
        try:
            resp = await orig(self, method, target, **kw)
        except Exception as e:  # noqa: BLE001
            loop.run_in_executor(None, lambda: _decide_after(
                call_id, 0, False, int((time.time() - started) * 1000), None, str(e), True))
            raise

        rec = _Recorder(lambda raw: loop.run_in_executor(None, lambda: _decide_after(
            call_id, resp.status, _ok(resp.status), int((time.time() - started) * 1000),
            raw.decode("utf-8", "replace"), None, True)))
        try:
            resp.content = _TapReader(resp.content, rec)
            orig_release = resp.release

            def release(*a, **k):
                rec.finish()  # 用户没读完就放掉了 —— 把已经收到的那部分报上去
                return orig_release(*a, **k)

            resp.release = release
        except Exception:  # noqa: BLE001
            pass
        return resp

    aiohttp.ClientSession._request = _request


# ── requests ───────────────────────────────────────────────


def _patch_requests(requests) -> None:
    if getattr(requests, "_agentmake_patched", False):
        return
    requests._agentmake_patched = True

    orig_send = requests.Session.send

    @functools.wraps(orig_send)
    def send(self, request, **kw):
        url = request.url or ""
        if _skip(url) or kw.get("stream"):
            return orig_send(self, request, **kw)

        body = request.body
        if isinstance(body, str):
            body = body.encode("utf-8")
        if not isinstance(body, (bytes, bytearray, type(None))):
            return orig_send(self, request, **kw)  # 文件流之类的，别碰

        def do_send(u, b):
            request.url = u
            if b is not None:
                request.body = b
                request.prepare_content_length(b)
            resp = orig_send(self, request, **kw)
            return resp.status_code, resp.ok, resp.text, resp

        def build(status, text, native):
            r = requests.Response()
            r.status_code = status
            r._content = text.encode("utf-8")
            r.url = url
            r.encoding = "utf-8"
            r.request = request
            r.headers = (
                native.headers if native is not None
                else requests.structures.CaseInsensitiveDict({"content-type": "application/json"})
            )
            r.raw = io.BytesIO(r._content)
            return r

        return run_call(url, request.method or "GET", body, dict(request.headers), do_send, build)

    requests.Session.send = send


# ── urllib ─────────────────────────────────────────────────


def _patch_urllib() -> None:
    import urllib.request as ur
    import urllib.error as ue
    import urllib.response as uresp

    if getattr(ur, "_agentmake_patched", False):
        return
    ur._agentmake_patched = True

    orig_open = ur.OpenerDirector.open

    @functools.wraps(orig_open)
    def opener(self, fullurl, data=None, timeout=ur.socket._GLOBAL_DEFAULT_TIMEOUT):
        req = fullurl if isinstance(fullurl, ur.Request) else ur.Request(fullurl, data=data)
        url = req.full_url
        if _skip(url):
            return orig_open(self, fullurl, data, timeout)

        body = req.data if isinstance(req.data, (bytes, bytearray)) else data
        headers = dict(req.header_items())

        def _wrap(status, text, headers_obj, u):
            return uresp.addinfourl(io.BytesIO(text.encode("utf-8")), headers_obj, u, status)

        def do_send(u, b):
            nreq = ur.Request(u, data=b, headers=headers, method=req.get_method())
            try:
                resp = orig_open(self, nreq, None, timeout)
            except ue.HTTPError as e:
                # HTTPError 本身就是个响应对象。读掉它的 body 才能交给断点看，
                # 读完必须重建，否则用户代码拿到的是一个已经被读空的流。
                raw = e.read()
                text = raw.decode("utf-8", "replace")
                rebuilt = ue.HTTPError(e.url, e.code, e.reason, e.headers, io.BytesIO(raw))
                return e.code, False, text, rebuilt
            raw = resp.read()
            text = raw.decode("utf-8", "replace")  # 只给观测用；交回用户的是原始字节
            status = getattr(resp, "status", 200) or 200
            native = uresp.addinfourl(io.BytesIO(raw), resp.headers, resp.url, status)
            return status, 200 <= status < 400, text, native

        def build(status, text, native):
            hdrs = getattr(native, "headers", None)
            if hdrs is None:
                import email.message

                hdrs = email.message.Message()
                hdrs["content-type"] = "application/json"
            return _wrap(status, text, hdrs, url)

        result = run_call(url, req.get_method(), body, headers, do_send, build)
        # 失败响应在 urllib 的契约里是**抛**出来的，不是返回 —— 别把契约改了，
        # 否则用户的 try/except HTTPError 会突然不生效
        if isinstance(result, ue.HTTPError):
            raise result
        return result

    ur.OpenerDirector.open = opener


# ── 按需打补丁 ─────────────────────────────────────────────
#
# httpx / requests 不一定装了，也可能在我们之后才被 import。装个 import 钩子，
# 谁被 import 就补谁 —— 既不强制依赖，也不会漏掉晚到的 import。

_TARGETS = {"httpx": _patch_httpx, "requests": _patch_requests, "aiohttp": _patch_aiohttp}


class _PatchOnImport(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if fullname not in _TARGETS:
            return None
        # 让默认机制去找，找到之后在 exec_module 后面接一手
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(fullname)
        except Exception:  # noqa: BLE001
            spec = None
        finally:
            sys.meta_path.insert(0, self)
        if spec is None or spec.loader is None:
            return None

        loader = spec.loader
        patch = _TARGETS[fullname]
        orig_exec = loader.exec_module

        def exec_module(module):
            orig_exec(module)
            try:
                patch(module)
            except Exception:  # noqa: BLE001
                if os.environ.get("AGENTMAKE_DEBUG"):
                    import traceback

                    traceback.print_exc()

        loader.exec_module = exec_module  # type: ignore[method-assign]
        return spec


_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    _installed = True

    transport.prime_http_armed()
    transport.emit(
        {
            "type": "run.started",
            "runId": RUN_ID,
            "seq": next_seq(),
            "ts": int(time.time() * 1000),
            "cwd": os.getcwd(),
            "argv": sys.argv,
            "pid": os.getpid(),
            "kind": "process",
            # 和 Node 侧同一套字段：运行组、重放基线。值为 None 时服务端按缺省处理
            "groupId": os.environ.get("AGENTMAKE_GROUP") or None,
            "replayOf": REPLAY_BASELINE,
        }
    )

    _patch_urllib()
    for name, patch in _TARGETS.items():
        mod = sys.modules.get(name)
        if mod is not None:
            try:
                patch(mod)
            except Exception:  # noqa: BLE001
                pass
    sys.meta_path.insert(0, _PatchOnImport())

    loops.init(RUN_ID, next_seq)
    if os.environ.get("AGENTMAKE_LOOPS") != "0":
        from . import loader

        loader.install()

    atexit.register(_finish)


def _finish() -> None:
    transport.emit(
        {
            "type": "run.ended",
            "runId": RUN_ID,
            "seq": next_seq(),
            "ts": int(time.time() * 1000),
            "exitCode": 0,
        }
    )
    transport.drain()
