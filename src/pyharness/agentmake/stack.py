"""从调用栈还原「是哪个函数发出了这次调用」。

这是拦截式调试能推导出执行图的关键：只看 LLM 调用的话，一条流水线往往只有一处
调模型，图上就只剩一个节点。调用栈能免费给出完整的函数层级，用户不改一行代码。

和 Node 侧 shared/stack.ts 保持同一套取舍，因为下游（flow.ts 的 stepIdOf）
是同一份代码：它取**倒数第二帧**当步骤身份，所以这里过滤后的最内层必须是
「用户那个直接发请求的封装函数」，而不是 SDK 内部。
"""

from __future__ import annotations

import os
import sys
import sysconfig
import traceback
from typing import Any, Dict, List

_HERE = os.path.dirname(os.path.abspath(__file__))
_SELF_ROOT = os.path.dirname(_HERE)  # src/pyharness

# 标准库与第三方包的位置。装在这些目录下的帧都不是"用户代码"。
_SKIP_DIRS: List[str] = []
for _key in ("stdlib", "platstdlib", "purelib", "platlib"):
    try:
        _p = sysconfig.get_paths().get(_key)
        if _p:
            _SKIP_DIRS.append(os.path.abspath(_p))
    except Exception:  # noqa: BLE001
        pass
_SKIP_DIRS.append(_SELF_ROOT)


def _is_user_frame(filename: str) -> bool:
    if not filename or filename.startswith("<"):
        return False  # <string>, <frozen importlib._bootstrap> 等
    path = os.path.abspath(filename)
    if "/site-packages/" in path or "/dist-packages/" in path:
        return False
    for skip in _SKIP_DIRS:
        if path.startswith(skip + os.sep) or path == skip:
            return False
    return True


def capture_frames(limit: int = 40) -> List[Dict[str, Any]]:
    """当前调用栈里属于用户代码的部分，顺序为「最外层 → 最内层」。

    extract_stack 本来就是外→内，和下游要求一致，不需要反转。
    """
    try:
        raw = traceback.extract_stack(limit=limit)
    except Exception:  # noqa: BLE001
        return []

    frames: List[Dict[str, Any]] = []
    for fs in raw:
        if not _is_user_frame(fs.filename):
            continue
        frames.append(
            {
                # 模块顶层在 Python 里叫 <module>，Node 侧叫 <top> —— 统一成 <top>，
                # 因为服务端的展示逻辑认这个名字
                "fn": "<top>" if fs.name == "<module>" else fs.name,
                "file": os.path.abspath(fs.filename),
                "line": fs.lineno or 0,
                "col": 0,
            }
        )

    # 匿名/顶层帧不带语义，夹在具名帧中间只会给图加噪声。
    named = [f for f in frames if f["fn"] != "<top>"]
    if named:
        return named
    # 但**全部都是顶层帧**时不能全丢 —— 那是"直接在脚本里发起调用"，
    # 丢光会让这次调用彻底从执行图里消失。保留最内层那一帧。
    return frames[-1:] if frames else []


def self_call(url: str) -> bool:
    """这次请求是不是打向调试器自己 —— 绝不能捕获，否则无限递归。"""
    from . import transport

    return url.startswith(transport.ENDPOINT)


_ = sys  # 保留导入，供调试时排查 sys.path 用
