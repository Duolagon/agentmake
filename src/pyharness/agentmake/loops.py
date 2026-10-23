"""循环运行时：被插桩的代码调用这里的钩子。

三件事，对应需求里的「实时调整 loop 方式」：
  改上限     —— 不去改用户的 MAX 变量（读不到），而是自己数轮次，到了就叫停
  立即跳出   —— 下一次进入循环体时直接 break
  再来一轮   —— 即使原条件已为假也强制返回 True

这三个都是**运行中**生效，不需要改代码、不需要重跑。

和 Node 侧的一处真实差异：`forceOneMore` 对 Python 的 `for` 循环无效。
Node 那边 for 的条件是个表达式，可以改写；Python 的 for 是遍历迭代器，
迭代器耗尽了就没法"再来一轮"。while 循环不受影响。这是语言差异，不是没做完。
"""

from __future__ import annotations

import os
import threading
from typing import Any, Callable, Dict, Optional

from . import transport

_states: Dict[str, Dict[str, int]] = {}
_overrides: Dict[str, dict] = {}
_lock = threading.Lock()

_run_id = ""
_seq: Callable[[], int] = lambda: 0

# 轮询上限：agent 的循环通常几十轮，每轮内还有几百毫秒的模型调用，
# 一次本地往返（~1ms）无所谓。但要防住紧凑循环 —— 超过这个轮数就不再取覆写。
POLL_LIMIT = int(os.environ.get("AGENTMAKE_LOOP_POLL_LIMIT", "200"))


def init(run_id: str, seq: Callable[[], int]) -> None:
    global _run_id, _seq
    _run_id = run_id
    _seq = seq


def _send(ev: dict) -> None:
    import time

    transport.emit({**ev, "runId": _run_id, "seq": _seq(), "ts": int(time.time() * 1000)})


def _state(loop_id: str) -> Dict[str, int]:
    with _lock:
        return _states.setdefault(loop_id, {"iter": 0, "entered": 0})


def set_override(loop_id: str, o: dict) -> None:
    """合并覆写。

    ⚠️ 一次性标志（breakNow / forceOneMore）是**脉冲**：服务端置位一次就清掉，
    之后每轮推回来的都是 False。直接覆盖会把本地还没来得及生效的挂起标志抹掉
    ——「再来一轮」就永远不会发生。所以这两个字段只允许置位，清除交给消费点。
    """
    with _lock:
        prev = _overrides.get(loop_id, {})
        nxt = {**prev, **o}
        nxt["breakNow"] = bool(prev.get("breakNow") or o.get("breakNow"))
        nxt["forceOneMore"] = bool(prev.get("forceOneMore") or o.get("forceOneMore"))
        _overrides[loop_id] = nxt


def _consume(loop_id: str, flag: str) -> None:
    with _lock:
        o = _overrides.get(loop_id, {})
        _overrides[loop_id] = {**o, flag: False}


def loop_test(loop_id: str, original: Any) -> Any:
    """while 的条件钩子：同步，返回最终的循环条件。"""
    try:
        s = _state(loop_id)
        o = _overrides.get(loop_id, {})

        if o.get("breakNow"):
            _consume(loop_id, "breakNow")
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"], "reason": "break"})
            return False
        mx = o.get("maxIterations")
        if mx is not None and s["iter"] >= mx:
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"], "reason": "max_override"})
            return False
        # 「再来一轮」只在原条件已经为假时才生效 —— 否则会在本来就要继续的那一轮被
        # 白白消费掉，等真正需要救回来时标志已经没了。
        if o.get("forceOneMore") and not original:
            _consume(loop_id, "forceOneMore")
            _send({"type": "loop.forced", "loopId": loop_id, "iteration": s["iter"]})
            return True
        if not original and s["entered"] > 0:
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"], "reason": "condition"})
        return original
    except Exception:  # noqa: BLE001 —— 插桩绝不能把用户的循环搞崩
        return original


def loop_enter(loop_id: str, end_line: int = 0) -> str:
    """进入一轮循环体：上报轮次、取回最新覆写、命中断点则阻塞。

    覆写在这里取、在下一次判断时生效（差一轮的延迟）—— 这就是「改上限 / 跳出 /
    再来一轮」能在循环跑着的时候生效的原因。

    for 循环没有可改写的条件表达式，所以上限和跳出都在这里直接返回 'break' 实现。
    """
    try:
        s = _state(loop_id)
        s["iter"] += 1
        s["entered"] += 1
        o = _overrides.get(loop_id, {})

        if o.get("breakNow"):
            _consume(loop_id, "breakNow")
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"] - 1, "reason": "break"})
            return "break"
        mx = o.get("maxIterations")
        if mx is not None and s["iter"] > mx:
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"] - 1, "reason": "max_override"})
            return "break"

        _send({"type": "loop.iteration", "loopId": loop_id, "iteration": s["iter"],
               "endLine": end_line, "maxOverride": mx})

        if transport.disabled() or s["iter"] > POLL_LIMIT:
            return "continue"

        # 命中循环断点时服务端会把响应悬住，被调试进程就停在轮次边界上；
        # 没断点时立即返回，只是顺带把最新覆写带回来。
        d = transport.hook(
            "/api/loop-gate",
            {
                "runId": _run_id,
                "loopId": loop_id,
                "iteration": s["iter"],
                "armed": bool(o.get("breakpoint")),
            },
        )
        if not d:
            return "continue"
        if d.get("override"):
            set_override(loop_id, d["override"])
        if d.get("action") == "break":
            _send({"type": "loop.exited", "loopId": loop_id, "iterations": s["iter"], "reason": "break_boundary"})
            return "break"
        return "continue"
    except Exception:  # noqa: BLE001
        return "continue"


def snapshot() -> list:
    with _lock:
        return [{"id": k, "iter": v["iter"], "override": _overrides.get(k, {})} for k, v in _states.items()]


def install_hooks(ns: Optional[dict] = None) -> None:
    """把钩子挂到 builtins —— 插桩后的代码直接按名字调用。"""
    import builtins

    builtins.__am_test = loop_test  # type: ignore[attr-defined]
    builtins.__am_enter = loop_enter  # type: ignore[attr-defined]
    _ = ns
