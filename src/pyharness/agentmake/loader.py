"""循环插桩：在用户模块被编译之前改写它的 AST。

改写的形状（源码一个字不动，改的是内存里的语法树）：

    for i in range(MAX):            for i in range(MAX):
        body                　→         if __am_enter("/x/a.py:12") == 'break': break
                                        body

    while cond:                     while __am_test("/x/a.py:20", cond):
        body                　→         if __am_enter("/x/a.py:20") == 'break': break
                                        body

为什么 for 和 while 处理得不一样：Python 的 for 是遍历迭代器，没有可改写的条件
表达式，所以"改上限 / 立即跳出"只能在进入循环体时做。while 有条件表达式，
两个位置都插 —— 这样 `forceOneMore`（原条件为假时强行再跑一轮）才有地方生效。

用 ast + compile，都是标准库，不引入依赖。
"""

from __future__ import annotations

import ast
import os
import sys
from importlib.abc import MetaPathFinder
from importlib.machinery import SourceFileLoader
from typing import Optional

from . import loops

_SELF_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _is_user_file(path: Optional[str]) -> bool:
    if not path or not path.endswith(".py"):
        return False
    p = os.path.abspath(path)
    if "/site-packages/" in p or "/dist-packages/" in p:
        return False
    if p.startswith(_SELF_ROOT + os.sep):
        return False
    import sysconfig

    for key in ("stdlib", "platstdlib"):
        try:
            d = sysconfig.get_paths().get(key)
            if d and p.startswith(os.path.abspath(d) + os.sep):
                return False
        except Exception:  # noqa: BLE001
            pass
    return True


class _LoopTransformer(ast.NodeTransformer):
    def __init__(self, filename: str) -> None:
        self.filename = filename

    def _loop_id(self, node: ast.AST) -> str:
        return f"{self.filename}:{getattr(node, 'lineno', 0)}"

    def _enter_guard(self, node: ast.AST) -> ast.If:
        """if __am_enter("id", end_line) == 'break': break

        结束行要一起传：服务端判断「这次调用在不在循环体内」需要一个区间，
        只有起始行的话，文件靠前的任意一个循环会把后面所有调用都吞进去。
        """
        end = getattr(node, "end_lineno", None) or getattr(node, "lineno", 0)
        call = ast.Call(
            func=ast.Name(id="__am_enter", ctx=ast.Load()),
            args=[ast.Constant(value=self._loop_id(node)), ast.Constant(value=end)],
            keywords=[],
        )
        test = ast.Compare(left=call, ops=[ast.Eq()], comparators=[ast.Constant(value="break")])
        return ast.If(test=test, body=[ast.Break()], orelse=[])

    def visit_For(self, node: ast.For) -> ast.AST:
        self.generic_visit(node)
        node.body = [self._enter_guard(node)] + node.body
        return node

    def visit_AsyncFor(self, node: ast.AsyncFor) -> ast.AST:
        self.generic_visit(node)
        node.body = [self._enter_guard(node)] + node.body
        return node

    def visit_While(self, node: ast.While) -> ast.AST:
        self.generic_visit(node)
        node.test = ast.Call(
            func=ast.Name(id="__am_test", ctx=ast.Load()),
            args=[ast.Constant(value=self._loop_id(node)), node.test],
            keywords=[],
        )
        node.body = [self._enter_guard(node)] + node.body
        return node


def transform_source(source: str, filename: str) -> str | ast.Module:
    """返回插桩后的 AST；任何问题都退回原始源码。

    「插不上就原样放行」是硬约束：这段代码跑在用户进程里，把人家的程序改坏了
    是我们的锅，而少一个循环控制只是少一个功能。
    """
    try:
        tree = ast.parse(source, filename=filename)
        tree = _LoopTransformer(filename).visit(tree)
        ast.fix_missing_locations(tree)
        # 编译一次做自检 —— 编不过就说明我们改坏了，退回原始源码
        compile(tree, filename, "exec")
        return tree
    except Exception:  # noqa: BLE001
        if os.environ.get("AGENTMAKE_DEBUG"):
            import traceback

            traceback.print_exc()
        return source


class _Loader(SourceFileLoader):
    def source_to_code(self, data, path, *, _optimize=-1):  # type: ignore[override]
        source = data.decode("utf-8") if isinstance(data, (bytes, bytearray)) else data
        out = transform_source(source, str(path))
        return compile(out, str(path), "exec", dont_inherit=True, optimize=_optimize)

    def get_code(self, fullname):
        # 绕开 .pyc 缓存：缓存里存的是**没插桩**的字节码，命中就等于插桩没生效，
        # 而且症状是"第一次跑好使，第二次不好使"，极难排查。
        source_path = self.get_filename(fullname)
        data = self.get_data(source_path)
        return self.source_to_code(data, source_path)


class _Finder(MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        # 让默认机制先定位，只在确认是用户的 .py 文件时才换掉 loader
        sys.meta_path.remove(self)
        try:
            import importlib.util

            spec = importlib.util.find_spec(fullname)
        except Exception:  # noqa: BLE001
            spec = None
        finally:
            sys.meta_path.insert(0, self)

        if spec is None or not isinstance(spec.loader, SourceFileLoader):
            return None
        if not _is_user_file(spec.origin):
            return None
        spec.loader = _Loader(fullname, spec.origin)
        return spec


_installed = False


def install() -> None:
    global _installed
    if _installed:
        return
    _installed = True
    loops.install_hooks()
    sys.meta_path.insert(0, _Finder())


def run_script(path: str, argv: list) -> None:
    """把一个脚本当 __main__ 跑，并且插桩。

    为什么需要它：`python foo.py` 时解释器直接编译 foo.py，**不走 importlib**，
    所以上面那个 meta_path 钩子够不着入口脚本。被 import 的模块不受影响。
    单文件脚本要循环控制就用：python -m agentmake foo.py
    """
    import types

    loops.install_hooks()
    abspath = os.path.abspath(path)
    sys.argv = [path] + argv
    # 脚本自己所在的目录要能 import —— `python foo.py` 时解释器会加，我们得补上
    sys.path.insert(0, os.path.dirname(abspath))

    with open(abspath, "r", encoding="utf-8") as fh:
        source = fh.read()
    code = compile(transform_source(source, abspath), abspath, "exec")

    # 真的建一个名为 __main__ 的模块并塞进 sys.modules：脚本里的
    # `if __name__ == "__main__"` 和 pickle 之类都依赖这个
    main_mod = types.ModuleType("__main__")
    main_mod.__file__ = abspath
    main_mod.__package__ = None
    sys.modules["__main__"] = main_mod
    exec(code, main_mod.__dict__)  # noqa: S102 —— 这就是"跑用户脚本"本身
