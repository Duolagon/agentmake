"""python -m agentmake your_script.py

给单文件脚本用的入口。`python foo.py` 时解释器直接编译 foo.py，不走 importlib，
所以循环插桩的 import 钩子够不着它 —— 走这个入口就能覆盖到。
被 import 的模块两种方式都能插桩。
"""

import sys

from . import install
from . import loader


def main() -> int:
    if len(sys.argv) < 2:
        print("用法: python -m agentmake <script.py> [args...]", file=sys.stderr)
        return 2
    install()
    script = sys.argv[1]
    loader.run_script(script, sys.argv[2:])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
