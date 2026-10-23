"""AgentMake Python harness —— 让任何 Python agent 零改动接入调试器。

    PYTHONPATH=/path/to/agentmake/src/pyharness  python your_agent.py

它做三件事：
  1. 拦住 HTTP 出口（httpx / requests / urllib），看到每一次模型调用
  2. 抓调用栈，让执行图能定位到是哪个函数、哪一行发的
  3. 给循环插桩，运行中改上限 / 跳出 / 每轮暂停

协议识别、归一化、指纹、断点决策都在服务端做（见 src/server/hook.ts），
这边只负责"抓栈 + 拦 HTTP + 按指令行事"。
"""

from .intercept import AgentMakeAbort, RUN_ID, install

__all__ = ["install", "RUN_ID", "AgentMakeAbort"]
