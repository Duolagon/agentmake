"""Python 侧的零侵入入口。

    PYTHONPATH=/path/to/agentmake/src/pyharness  python your_agent.py

`site` 模块在解释器启动时会自动 import 名为 sitecustomize 的模块 —— 这是 Python
里对应 Node `--import` 的机制。用户代码一行不改，也不用装包。

安全阀：AGENTMAKE=0 直接关掉。

⚠️ 一个真实的坑：如果用户环境里本来就有 sitecustomize（某些发行版、conda、
公司内部工具会放），我们会把它**盖掉**。所以装完自己之后要把它找出来接上，
否则用户的环境会以一种极难排查的方式坏掉 —— 他只知道"自从用了这个调试器，
某个不相干的东西就不工作了"。
"""

import os
import sys

if os.environ.get("AGENTMAKE") != "0":
    try:
        import agentmake

        agentmake.install()
    except Exception:  # noqa: BLE001 —— 装不上就装不上，绝不能让用户的程序起不来
        if os.environ.get("AGENTMAKE_DEBUG"):
            import traceback

            traceback.print_exc()


def _chain_original_sitecustomize() -> None:
    """把被我们遮住的那个 sitecustomize 找出来执行掉。"""
    here = os.path.dirname(os.path.abspath(__file__))
    import importlib.util

    for entry in sys.path:
        try:
            if not entry or os.path.abspath(entry) == here:
                continue
            candidate = os.path.join(entry, "sitecustomize.py")
            if not os.path.isfile(candidate):
                continue
            spec = importlib.util.spec_from_file_location("_agentmake_prev_sitecustomize", candidate)
            if spec and spec.loader:
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
            return
        except Exception:  # noqa: BLE001
            return


_chain_original_sitecustomize()
