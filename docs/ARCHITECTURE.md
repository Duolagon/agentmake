# AgentMake 架构设计文档

**LangGraph Agent 可视化调试器** — 导入现有 agent 即可看到其结构、下断点、单步执行、运行中增删规则；也支持在画布上创作新 agent（编译为真实 LangGraph 代码）。

> 版本：v0.5 (2026-08-10)
> **交付形态：常驻浏览器页面（人的监视屏）+ MCP Server（AI 的感官与手）**
> 技术栈：React 19 + React Flow / Python 3.12 + FastAPI + SQLite
> 目标框架：LangGraph / LangChain　模型：Gemini + Claude + OpenAI（拦截式归一化）
> 面向的开发方式：**AI 辅助编程**（Claude Code / Cursor 等）——我们不做编辑器，用户的编辑器是 AI

---

## 0. 定位变更沿革（v0.2 → v0.3 → v0.4 → v0.5）

v0.2 设计的是「低代码创作平台」——图是权威，平台自研引擎执行。v0.3 定位变更为**调试器**：

| | v0.2 | v0.3 |
|---|---|---|
| 权威来源 | 平台的 Graph JSON | **用户的 LangGraph 代码** |
| 谁执行 | 平台自研引擎 | **LangGraph，跑在平台托管的子进程里** |
| 图从哪来 | 用户在画布上画 | **从代码静态解析 + 运行时 trace 叠加** |
| 画布的角色 | 创作工具 | **视图 + 编辑器 + 代码生成器** |
| 类比 | Dify / Coze / n8n | **Chrome DevTools，面向 agent** |

v0.2 中**存活**的部分：事件协议、Trace 存储与可视化、Provider 归一化思路、成本核算、SQLite 选型。
v0.2 中**作废**的部分：自研 Scheduler / StateStore / NodeRunner、自研 checkpoint、发布为外部 API。

### 0.1 v0.4（已废弃）：曾定为 VS Code 扩展

需求「不想来回切 IDE」一度指向 VS Code 扩展方案（省掉自建编辑器的 4 周）。**已被 v0.5 取代**，理由见下。此方案的技术判断依然成立，架构上不排斥后续以插件形式回归（后端完全不变）。

### 0.2 v0.5：面向 AI 编程的形态

需求修正：**主力开发方式是 AI 辅助编程（Claude Code / Cursor），不是在 IDE 里手敲代码。**

这个前提一变，整条推理链就变了：

| 原假设 | 实际情况 |
|---|---|
| 人需要一个好编辑器 | **人的编辑器是 AI**。文本编辑不是主要交互 |
| 所以要么自建 Monaco，要么寄生 VS Code | **「编辑器」这个问题应该消失，而不是被解决** |
| 可视化是 IDE 里的一个面板 | 可视化应该是**常驻的第二屏监视器**，不随 IDE 切换 |

更关键的是，这暴露了一个之前没看见的空白：

> **AI 在改 agent 时是瞎的。** 它只能读代码猜运行时行为，而 90% 的 agent bug 恰恰藏在「实际发出去的 prompt 长什么样」里——那是 f-string 拼接 + 截断 + 变量展开之后的东西，读代码推不出来。

所以 v0.5 的交付形态是两个消费者共享同一份 trace：

| 消费者 | 形态 | 用途 |
|---|---|---|
| **人** | 常驻浏览器页面 | 实时看 agent 在干什么；手动改 prompt 做快速试探 |
| **AI** | **MCP Server** | 给 Claude Code 装上 agent 运行时的「感官」和「手」 |

净效果对比 v0.4：

- **去掉**：Extension Host、webview 桥、编辑器集成层（Hover/CodeLens/装饰器）
- **加上**：MCP Server（约 3–4 天，复用已有 HTTP API 的内部实现）
- **结论**：比 VS Code 路线**更便宜**，且差异化更强

**明确不做**：代码编辑器、LSP、内建终端、内建 Git 面板、内建 AI 对话框。前四项交给用户已有的工具，最后一项交给 Claude Code——在页面里再造一个弱化版聊天框是重复建设。

---

## 1. 产品目标

| 目标 | 具体含义 |
|---|---|
| **导入即可视** | 指向一个 LangGraph 项目目录，无需改代码，立刻看到图结构 |
| **真实执行** | 跑的是你的原代码、你的依赖、你的数据库，不是翻译版本 |
| **任意断点** | 节点前/后、LLM 调用前/后、工具调用前/后，六类断点 |
| **运行中改规则** | 暂停时改 system prompt、messages、工具定义、模型参数、state，继续执行立即生效 |
| **伪造与注入** | 伪造 LLM 响应、伪造工具返回值，无需真实调用即可测分支 |
| **时间旅行** | 回到任意历史 checkpoint，改完从那里重跑（LangGraph 原生能力） |
| **改动回流** | 调试中验证过的修改写回源码，含语法校验与备份 |
| **AI 可用**（v0.5 核心） | 以 MCP 暴露上述全部能力，让 Claude Code 能「看见」agent 运行时并自主迭代 |
| **画布创作** | 从零画一个 agent，编译成真实 LangGraph 代码 |

### 1.1 非目标

- 多用户 / 多租户 / RBAC
- 调试非 LangGraph 的任意 Python agent（v2 用纯拦截模式兜底，见 §5.4）
- 把 agent 发布成对外 API（那是部署工具的活，不是调试器）
- 替代 pdb（我们调的是 agent 语义层，不是任意代码行）

---

## 2. 最核心的架构决策：统一到 LangGraph 运行时

**导入调试和画布创作共用同一个运行时，画布创作通过代码生成落到 LangGraph。**

```
  导入路径                                   创作路径
  ────────                                   ────────
  用户的 LangGraph 项目                       画布操作
        │                                        │
        │ 静态解析 (LibCST + get_graph())        │ codegen
        ▼                                        ▼
   ┌─────────────────── Graph IR ───────────────────┐
   │  节点 / 边 / state schema / 规则位置索引        │
   └────────────────────┬───────────────────────────┘
                        │ 都指向磁盘上真实的 .py 文件
                        ▼
        ┌───────────── 托管子进程 ─────────────┐
        │  Harness: import → compile(注入)     │
        │    · checkpointer (SqliteSaver)      │
        │    · interrupt_before = 全部节点     │
        │    · callbacks + SDK patch           │
        │  ← JSON-RPC over stdio →  Debugger   │
        └──────────────────────────────────────┘
```

**为什么不给画布单独写一个引擎**：

1. 两套执行语义必然发散，最终产生「画布里能跑，导出后行为不一样」——这是同类工具最常见的信任崩塌点
2. 调试器要写两遍
3. 画布产物无法带走，形成锁定

**代价**：画布的表达能力受限于 codegen 能生成的范围。接受这个约束——它逼着画布保持诚实。

---

## 3. LangGraph 原生能力盘点（不要重复造）

这是 v0.3 相比 v0.2 工作量大降的原因。LangGraph 已经把执行层最难的部分做完了：

| 需求 | LangGraph 原生提供 | 我们要做的 |
|---|---|---|
| 图拓扑 | `graph.get_graph()` → 节点/边（含条件边候选集） | 渲染成画布、叠加 trace |
| 状态模型 | `StateGraph(State)`，显式 TypedDict/Pydantic + reducer（`Annotated[list, add]`） | 读 schema 渲染表单、diff 可视化 |
| 检查点 | `checkpointer=SqliteSaver(...)`，每个 super-step 自动存 | 用它做时间旅行 UI |
| 断点 | `compile(interrupt_before=[...], interrupt_after=[...])` | **动态断点**（见 §7.2 的技巧） |
| 状态查看 | `graph.get_state(config)` → `.values` / `.next` | Inspector 面板 |
| 状态修改 | `graph.update_state(config, values, as_node=...)` | UI 上直接编辑 state |
| 历史遍历 | `graph.get_state_history(config)` → 全部 checkpoint | 时间轴 |
| 时间旅行 | 用历史 `checkpoint_id` 重新 invoke，从那点续跑 | Rewind + Fork UI |
| 流式事件 | `astream(stream_mode=["values","updates","messages","debug"])` | 事件源之一 |
| 恢复执行 | `graph.invoke(None, config)` 从中断处继续 | Resume 按钮 |

> ⚠️ 上表按 LangGraph 当前主线 API 编写。**接入时第一件事是对着项目里实际安装的版本核对一遍**（`langgraph.__version__`），尤其是 `interrupt_before` 能否在 invoke 时动态传入、`Send` API 的事件形状。这些在小版本间变过。Harness 层要做版本探测并在不兼容时明确报错，而不是静默降级。

**结论：我们不写执行引擎，我们写的是「注入 + 观测 + 控制 + 可视化 + 代码回写」。**

---

## 4. 分层架构

```
┌── 浏览器：常驻监视屏（人）──────┐   ┌── Claude Code / Cursor（AI）───┐
│  Canvas(React Flow) │ Trace     │   │  读代码 · 改代码 · 跑验证      │
│  Inspector │ State │ Changes    │   │                                │
│  手动改 prompt + 作用域选择     │   │                                │
└──────────────┬──────────────────┘   └──────────────┬─────────────────┘
       REST + SSE (127.0.0.1)                   MCP (stdio)
┌──────────────▼──────────────────────────────────────▼─────────────────────┐
│  FastAPI  Debugger Server  —— 同一份 trace，两个消费者                     │
│  ┌──────────┐┌───────────┐┌───────────┐┌──────────┐┌──────────────────┐  │
│  │ Project  ││ Introspect││ Session   ││ Codegen  ││ EventBus         │  │
│  │ 目录/venv││ 静态解析  ││ 子进程管理││ /Patch   ││ 广播+持久        │  │
│  │ /入口点  ││ →Graph IR ││ 控制RPC   ││ LibCST   ││                  │  │
│  └──────────┘└───────────┘└───────────┘└──────────┘└──────────────────┘  │
│  ┌────────────────────── Provider 归一化 (IR ⇄ 原生) ──────────────────┐  │
│  │        Gemini      │      Claude      │      OpenAI                │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ JSON-RPC over stdio (双向)
┌───────────────────────────────▼──────────────────────────────────────────┐
│  托管子进程（用户项目的 venv）                                            │
│  ┌────────────────────────── Harness ─────────────────────────────────┐  │
│  │ 1. import 用户模块，拿到 StateGraph                                │  │
│  │ 2. compile(checkpointer=…, interrupt_before=所有节点)              │  │
│  │ 3. 注册 LangChain callbacks + monkey-patch 各家 SDK                │  │
│  │ 4. 驱动 astream，每个中断点向 Debugger 请示                        │  │
│  └────────────────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │  用户的 agent 代码（一行不改）→ 真实调 Gemini/Claude/工具/DB       │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────┘
```

**为什么用子进程而不是同进程**：用户代码的依赖版本会和 Debugger 冲突（LangChain 生态尤其严重）；用户代码可能 `sys.exit()` 或崩溃；托管模式下我们要能随时 kill 和重启。子进程跑在**用户项目自己的 venv** 里，Debugger 的依赖完全不污染它。

**通信选 stdio JSON-RPC 而非 HTTP**：子进程由我们 spawn，stdio 天然私有、无需端口分配、无需鉴权、进程死了管道自动关闭。用户代码自己的 stdout 用 `contextlib.redirect_stdout` 隔开，单独作为 `log` 事件转发。

### 4.1 MCP Server：给 AI 装上感官与手

这是 v0.5 的核心差异化。Debugger Server 同时暴露一个 MCP server（stdio 传输，Claude Code / Cursor 一行配置即可接入），把 trace 数据和控制能力开放给 AI 编程助手。

**为什么这件事有价值**：AI 改 agent 时只能读代码猜运行时行为。而 agent 的 bug 大多藏在「实际发出去的 prompt 到底长什么样」——f-string 拼接 + 列表截断 + 变量展开之后的最终形态，读代码推不出来。给 AI 一个 `get_rendered_prompt()`，等于把它从盲改变成了看着仪表盘改。

#### 感官（只读）

| 工具 | 返回 | 备注 |
|---|---|---|
| `get_graph()` | 拓扑 + 节点列表 + 各节点源码位置 | |
| `list_runs(limit, status?)` | 运行摘要列表 | |
| `get_run_summary(run_id)` | 状态、耗时、成本、走过的路径、失败点 | 默认入口，token 友好 |
| `find_failures(run_id)` | **直接定位出错的步骤 + 上下文** | 省掉 AI 自己翻 trace |
| `get_rendered_prompt(run_id, step)` | ★ 实际发出的完整 system + messages + tools | 最高价值 |
| `get_state_at(run_id, checkpoint)` | state 快照 | |
| `get_step_detail(run_id, seq)` | 单步完整详情 | 钻取用 |
| `get_coverage()` | 从未执行过的分支/节点 | |

#### 手（写与控制）

| 工具 | 作用 |
|---|---|
| `run_agent(input, breakpoints?)` | 触发一次运行 |
| `rerun_from(run_id, checkpoint, patches?)` | ★ 从检查点改完重跑——**不用从头跑，省钱省时间** |
| `patch_rule(node, rule_id, value, scope)` | 改规则（三种作用域同 §7.3） |
| `fake_tool_result(run_id, call_id, result)` | 伪造工具返回，测异常分支 |
| `compare_runs(run_a, run_b)` | 两次运行的结构化差异 |

#### `rerun_from` 是 AI 自主实验循环的关键

有了它，AI 可以自己迭代而不用人参与、也不用每次从头烧钱：

```
改 prompt → rerun_from(ckpt_3) → compare_runs → 不行 → 再改 → 再跑
```

一次典型工作流：

```
你：这个 agent 处理紧急工单时优先级老判断错

AI: run_agent({"ticket": "订单延迟三天，客户要投诉"})
    find_failures(run_7)               → analyze 输出 priority=normal
    get_rendered_prompt(run_7, "analyze")
                                       → 历史只截了 5 条，"urgent" 在第 7 条被截掉
    [改代码]
    rerun_from(run_7, ckpt_3)          → 只重跑后半段验证
    ✓ priority=urgent
    ↑ 全程你在浏览器页面上实时看着
```

#### Token 效率是硬约束

一次长 run 的完整 trace 可能十万 token 级别，直接返回会撑爆 AI 的上下文。设计原则：

- **摘要优先，按需钻取**：`get_run_summary` 返回精简概览 + 各步骤的 `seq`，AI 想看细节再调 `get_step_detail(seq)`
- **`find_failures` 是首选入口**，它直接给出「哪一步错了 + 那一步的完整上下文」，通常一次调用就够
- 所有返回大文本的工具（`get_rendered_prompt`）支持 `max_chars` 截断 + 明确的截断标记
- 不提供 `get_full_trace()` 这种一次性倾倒全部的工具

### 4.2 页面：人的常驻监视屏

浏览器页面（`127.0.0.1:8787`）是被动监视器——**任何来源的运行都会实时出现**，不需要用户在页面上点「运行」。Claude Code 在终端跑一次、你自己跑一次 pytest、页面上点重跑，都在同一块屏上显示。

这依赖 §5.3 的附着模式。

### 4.3 跳到源码：深链到用户自己的编辑器

页面上不做代码编辑，但要能一键跳过去看：

```
vscode://file/{abs_path}:{line}:{col}      # VS Code
cursor://file/{abs_path}:{line}:{col}      # Cursor
```

编辑器类型作为一项配置，默认 `vscode`。约一小时的工作量，覆盖「我想看看这段代码」的需求，不必自建编辑器。

---

## 5. Project 与执行接入

### 5.1 Project 定义

一个被调试的 agent = 一个本地目录 + 一份声明：

```toml
# agentmake.toml —— 放在用户项目根目录
[project]
name = "ticket-agent"
python = ".venv/bin/python"          # 留空则自动探测 .venv / uv / poetry

[entry]
module = "app.graph"                  # import 这个模块
attr   = "graph"                      # 取这个属性（StateGraph 或已 compile 的）
                                      # 或用 factory = "build_graph" 调函数拿

[run]
env_file = ".env"                     # 载入环境变量（GOOGLE_API_KEY 等）
cwd = "."

[debug]
checkpointer = "auto"                 # auto = 我们注入 SqliteSaver；keep = 用你自己配的
sample_inputs = "tests/inputs.json"   # 一键跑的示例输入
```

如果没有这个文件，平台提供一个引导流程：扫描目录找 `StateGraph(` 的定义点，让用户确认入口。

### 5.2 子进程生命周期

```
Session 创建 → spawn(python -m agentmake_harness) → 握手（交换版本/能力）
             → 载入模块、compile、上报 Graph IR
             → 等待 run 指令
run → 驱动 astream → 每个中断点请示 → ... → 结束
     ↑                                        │
     └────── 可多次 run，进程复用 ─────────────┘
代码变更 → 检测到文件 mtime 变化 → 提示重启（或自动重启）
Session 关闭 / 用户点 Restart → SIGTERM → 超时 SIGKILL
```

**进程复用很重要**：LangChain 的 import 开销以秒计，每次 run 重启子进程会毁掉调试体验。默认复用，只在代码变更或用户显式要求时重启。

**代码热重载不做。** Python 的模块热重载在有闭包/装饰器/全局单例的项目里不可靠，会产生比它解决的更多的诡异 bug。改代码 → 重启进程，2 秒的事，比不确定性划算。

### 5.3 两种接入模式：附着 与 托管

AI 编程改变了「谁启动进程」这件事。**Claude Code 会自己跑 `python main.py` 或 `pytest`，不会经过我们的启动器。** 所以附着模式是主要模式。

| 模式 | 谁 spawn | 场景 | 优先级 |
|---|---|---|---|
| **附着 (attach)** | 用户 / AI 在终端启动 | 日常开发——Claude Code 跑脚本、你跑 pytest | **主要** |
| **托管 (managed)** | Debugger Server spawn | 页面上点「重跑」、`rerun_from`、批量回归 | 次要 |

两种模式共用同一套 Harness，只是握手方向相反：附着模式下 Harness 主动连 Debugger Server（读 `.agentmake/port` 或环境变量），托管模式下 Debugger Server 通过 stdio 拉起它。

#### 零侵入的自动附着

往项目 venv 的 `site-packages` 丢一个 `.pth` 文件：

```
# agentmake.pth
import agentmake_harness.autoattach
```

之后该 venv 里**任何** Python 进程启动时都会尝试连接本地 Debugger Server。Claude Code 随手跑个脚本，页面上就实时出现了。

安全阀（`.pth` 会在每个进程启动时执行，必须极度克制）：

- `AGENTMAKE=0` 环境变量可完全关闭
- 只在检测到项目根有 `agentmake.toml` 时才激活
- 连不上 Debugger Server 就**静默放弃**，绝不阻塞、绝不报错、绝不拖慢用户进程启动
- `autoattach` 模块本身只做惰性导入，不 import langgraph/langchain（否则会拖慢所有 Python 进程）
- 安装是一个显式命令 `agentmake install-hook`，不偷偷做；`agentmake uninstall-hook` 可撤销

不想用 `.pth` 的用户，退化为在入口加一行 `import agentmake; agentmake.attach()`。

### 5.4 依赖与环境

用户项目自带 venv，我们只负责往里装一个轻量包：

```
agentmake-harness   # 只依赖 stdlib + 用户已有的 langgraph/langchain-core
```

刻意做到**近乎零依赖**——任何新依赖都可能和用户项目的版本约束冲突。JSON-RPC 手写（几十行），不引入 rpc 框架。

### 5.5 非 LangGraph 项目的兜底（v2）

如果用户的 agent 不是 LangGraph 写的，Harness 退化为**纯 SDK 拦截模式**：monkey-patch 各家 SDK，图从 trace 推导，断点只能下在 LLM/工具边界，没有 state 视图和时间旅行。能力打折但仍可用。v1 不做，架构上不排斥。

---

## 6. 插桩：三个信息源

单一信息源不够，需要三层叠加：

| 层 | 来源 | 提供什么 | 覆盖范围 |
|---|---|---|---|
| **图层** | `graph.get_graph()` + `astream(stream_mode="updates")` | 节点进出、state 变化、走了哪条边 | LangGraph 节点粒度 |
| **链层** | LangChain `BaseCallbackHandler` | LLM 调用的 prompt/响应/token、tool 调用、chain 嵌套 | 走 LangChain 抽象的调用 |
| **SDK 层** | monkey-patch `google.genai` / `anthropic` / `openai` | 真实发出的 HTTP 载荷 | **所有**调用，包括绕过 LangChain 直接调 SDK 的 |

**为什么三层都要**：很多真实项目是混的——图是 LangGraph，但某个节点里直接 `genai.Client().models.generate_content(...)` 绕过了 LangChain。只挂 callbacks 会漏掉它。SDK 层是兜底，保证「没有一次模型调用是看不见的」。

三层事件通过 `(thread_id, checkpoint_id, node_name, call_seq)` 关联，在 UI 上折叠成一棵树：

```
▼ node: analyze_ticket                        [1.2s] [$0.008]
  ▼ llm: gemini-2.5-pro                       [0.9s] 8.4k→612 tok
      system_instruction  (可编辑 ✎ 可回写)
      contents[]          (可编辑 ✎)
      tools[]             (可编辑 ✎ 可回写)
      ▸ thinking (summary)
      ▸ response
  ▼ tool: search_kb                           [0.3s]
      args   {"q": "订单延迟"}                (可编辑 ✎)
      result [...]                            (可伪造 ⚡)
  state diff: +findings[2]  score: 0→0.62
```

### 6.1 SDK patch 的注意事项

- 同时 patch 同步和异步入口，以及流式版本（`generate_content_stream` / `messages.stream`）
- 用 `wrapt` 风格的代理保留签名和 `__wrapped__`，避免破坏用户代码里的内省
- patch 失败（SDK 版本不认识）不能让整个 session 挂掉——降级为「该 provider 只有 callback 层数据」并在 UI 上明示
- 记录 patch 是否生效，UI 上要能看到「本次会话的观测覆盖度」

---

## 7. 调试控制

### 7.1 六类断点

| 断点位置 | 实现 | 能改什么 |
|---|---|---|
| 节点执行前 | LangGraph `interrupt_before` | state（`update_state`）、该节点的配置 |
| 节点执行后 | LangGraph `interrupt_after` | state |
| LLM 调用前 | SDK patch 内阻塞 | **system / messages / tools / 模型 / 参数** |
| LLM 调用后 | SDK patch 内阻塞 | **响应内容（伪造）** |
| 工具调用前 | callback + patch 内阻塞 | 工具入参 |
| 工具调用后 | 同上 | **工具返回值（伪造）** |

后四类是 LangGraph 没有的，靠我们在 patch 里实现——拦截函数里同步等待 Debugger 的放行指令：

```python
# harness/intercept.py（简化）
def intercept_llm(provider: str, native_request: dict, call):
    ir = normalize(provider, native_request)              # 原生 → IR
    decision = rpc.request("llm.before", ir, blocking=True)   # ← 断点在此阻塞

    if decision.action == "fake":                          # 伪造响应，不真调
        return denormalize_response(provider, decision.response)
    if decision.patch:
        native_request = apply_patch(provider, native_request, decision.patch)

    resp = call(native_request)                            # 真实调用
    decision = rpc.request("llm.after", normalize_resp(resp), blocking=True)
    return apply_response_patch(resp, decision) if decision.patch else resp
```

阻塞的是**用户的子进程**，这正是调试器该有的行为。Debugger 端不阻塞，UI 照常响应。

### 7.2 动态断点的技巧

LangGraph 的 `interrupt_before` 是 **compile 时**指定的。要支持「运行中随时加断点」，做法是：

> **compile 时对所有节点开 interrupt，是否真的停由 Harness 的控制层决定。**

每个节点前都会把控制权交回 Harness，Harness 查一下当前断点集合：命中就上报并阻塞等指令，没命中就立刻 `invoke(None, config)` 继续。代价是每个节点多一次 checkpoint 往返（SQLite 本地，微秒级），换来断点完全动态。

> 需核对：部分版本对 `interrupt_before="*"` 的支持不同，可能需要显式列出全部节点名——Harness 从 `get_graph().nodes` 取即可。

### 7.3 改规则：作用域三选一

暂停时改一个 system prompt，用户想要的可能是三种不同的事，UI 必须让他明确选：

| 作用域 | 语义 | 实现 |
|---|---|---|
| **仅此一次** | 只影响当前这一次调用 | patch 当前 request，不记录 |
| **本次运行** | 本次 run 内该节点每次都用新值 | 存进 session 的 override 表 |
| **写回源码** | 进 pending diff，review 后落盘 | 见 §9 |

默认「仅此一次」——调试时绝大多数修改是试探性的，默认写回会污染代码。

### 7.4 时间旅行

直接用 LangGraph 的 checkpoint 历史：

```python
# 列出历史
snapshots = list(graph.get_state_history(config))
# 从某个 checkpoint 重新执行（LangGraph 会 fork 出新分支）
new_config = {"configurable": {"thread_id": tid, "checkpoint_id": target_ckpt}}
graph.invoke(None, new_config)
```

配合 §7.3 的「本次运行」作用域，就得到核心工作流：

```
跑到第 8 步发现输出不对
  → 回到第 5 步（analyze 节点之前）
  → 改 analyze 的 system prompt（作用域=本次运行）
  → 从第 5 步继续跑
  → 对比新旧两个分支在第 8 步的输出
  → 满意 → 切到「写回源码」→ review diff → apply
```

**分支永不覆盖**：每次 rewind 产生新 `checkpoint_id` 分支，原路径保留，UI 上呈现为一棵运行树。

### 7.5 重放（省钱省时间）

记录每次 LLM 响应，重跑时可选「前 N 次调用回放缓存」。改的是第 6 个节点的 prompt，前 5 个节点就不必真花钱重跑。缓存键 = 归一化 request 的哈希；request 变了自动穿透到真实调用。

---

## 8. Graph IR 与双向映射

### 8.1 IR 结构

IR 是画布、代码解析、代码生成三者之间的中间表示。

```jsonc
{
  "source": "imported",            // imported | authored
  "framework": { "name": "langgraph", "version": "0.6.x" },
  "state_schema": {
    "ref": "app/state.py:TicketState",
    "channels": {
      "messages": { "type": "list", "reducer": "add_messages",
                    "loc": "app/state.py:12" },
      "score":    { "type": "float", "reducer": null, "loc": "app/state.py:14" }
    }
  },
  "nodes": [{
    "id": "analyze",
    "impl": { "kind": "function", "ref": "app/nodes.py:analyze_ticket",
              "loc": { "file": "app/nodes.py", "line": 23, "end_line": 58 } },
    "rules": [                      // ★ 可编辑规则的源码索引，见 §9
      { "id": "sys", "kind": "system_prompt",
        "loc": { "file": "app/nodes.py", "line": 27, "col": 18, "end_line": 34 },
        "writability": "static_literal",
        "preview": "你是一个工单分析助手…" },
      { "id": "model", "kind": "model_param",
        "loc": { "file": "app/nodes.py", "line": 25 },
        "writability": "static_literal", "value": "gemini-2.5-pro" }
    ]
  }],
  "edges": [
    { "from": "analyze", "to": "route", "kind": "normal" },
    { "from": "route", "kind": "conditional",
      "fn": { "ref": "app/nodes.py:pick_branch", "loc": {...} },
      "candidates": ["escalate", "auto_reply", "__end__"] }
  ]
}
```

### 8.2 静态解析（imported 路径）

两条腿走路：

1. **运行时 introspection**（准确）：Harness 里 `graph.get_graph()` 拿到真实拓扑——这是 LangGraph 自己算出来的，绝对准确。
2. **LibCST 静态分析**（定位）：解析源码，找到每个节点函数的定义位置、以及函数体内的字符串字面量/模型名/工具定义，建立 `rules[]` 的源码坐标索引。

两者用节点名关联。**运行时给拓扑，静态分析给坐标**——单靠任一个都不够：`get_graph()` 不知道 prompt 写在第几行，LibCST 算不准条件边的真实走向。

> 用 **LibCST 而不是 `ast`**：`ast` 丢失格式和注释，回写时会把用户整个文件重新格式化——不可接受。LibCST 保留 concrete syntax，能做外科手术式的替换。

### 8.3 条件边的处理

`add_conditional_edges(source, fn, path_map)` 的实际走向由运行时决定。UI 上：

- 静态显示全部候选边（灰色虚线）
- 跑过之后，实际走过的边高亮，未走过的保持灰色 —— **「哪些分支从没被覆盖过」本身就是极有价值的调试信息**
- 点击条件边可以看到路由函数的源码和历次运行的返回值分布

---

## 9. 代码回写（最难的部分）

### 9.1 可回写性分析

**不是每个能在 UI 上看到的值都能写回源码。** 必须先分类，且必须在 UI 上诚实标注：

| 分类 | 含义 | 能否回写 | UI 标记 |
|---|---|---|---|
| `static_literal` | 源码里的字符串字面量 | ✅ 精确替换 | ✎ 可写回 |
| `static_composed` | f-string / 拼接，各段都是字面量 | ⚠️ 需选择改哪一段 | ✎ 需选段 |
| `config_file` | 来自 yaml/json/toml | ✅ 改配置文件，最干净 | ✎ 可写回 |
| `runtime_computed` | 运行时从变量、DB、检索结果算出 | ❌ 只能临时试验 | ⚡ 仅本次 |

**判定方法**：把运行时拦截到的实际值，与静态分析出的候选字面量做匹配——精确相等 → `static_literal`；是某个 f-string 模板去掉插值后的骨架 → `static_composed`；匹配不上 → `runtime_computed`。

这个诚实标注不能省。用户在 UI 上改了一个 prompt 然后以为存下来了、结果重跑还是老的——这种体验会直接毁掉工具的可信度。

### 9.2 外科手术式补丁

```python
# codegen/patcher.py（简化）
import libcst as cst

class ReplaceLiteral(cst.CSTTransformer):
    """只替换指定位置的那一个字符串字面量，文件其余部分逐字节不变"""
    def __init__(self, target_pos, new_value): ...
    def leave_SimpleString(self, orig, updated):
        if self.pos_of(orig) != self.target_pos:
            return updated
        return updated.with_changes(value=self.render(new_value, orig.prefix, orig.quote))
```

要点：

- **保留原有引号风格和前缀**（`"""` / `'` / `f` / `r`），不要把三引号改成单引号
- 多行字符串保持缩进
- 一次 apply 多处修改要**从后往前**改，避免位置偏移
- 改完跑一次 `ast.parse()` 验证语法有效，失败就整体放弃并报错

### 9.3 落盘策略：直接写 + 可撤销

本地自用、调自己的代码、有 git —— **默认直接写盘**，采用编辑器的 undo 模型而非 PR 的 review 模型。

```
用户在 Inspector 里改 prompt，作用域选「写回源码」
   → 立即写盘（先备份到 .agentmake/backups/<ts>/）
   → 顶部出现一条可撤销的提示：「已写入 app/nodes.py:27  [查看 diff] [撤销]」
   → 撤销 = 从备份还原，不依赖 git
```

写盘前的硬性检查（这些不能省，但都是无感的自动检查，不是让用户点确认）：

1. **语法校验**：改完的文件 `ast.parse()` 必须通过，失败则整体放弃并报错
2. **mtime / hash 冲突检测**：文件在平台读取之后被外部改过 → 拒绝写入，提示重新解析（防止覆盖你在 IDE 里的修改）
3. **自动备份**：写入前把原文件复制到 `.agentmake/backups/`，保留最近 50 次
4. **git 感知**：如果项目在 git 里且工作区不干净，提示一句（不阻塞）

**聚合 review 作为可选视图**，不是必经流程：

```
GET  /api/sessions/{id}/changes           本次会话改过的所有文件
GET  /api/sessions/{id}/changes/diff      聚合 unified diff
POST /api/sessions/{id}/changes/revert    {edit_ids}  批量回退
```

用于 commit 前过一眼「这次调试到底改了些什么」——注意这里会同时包含 **AI 改的**和你手动改的。页面里用轻量只读 diff 渲染器（`diff2html` 之类）；要逐行编辑就深链回你自己的编辑器。

> **设计理由**：调试主循环里的修改绝大多数用「仅此一次」/「本次运行」作用域，根本不碰文件。主动选择「写回源码」本身就是一个「我确认要保存」的动作，再插一道 review 是重复确认。真正的安全网是 git + 自动备份，不是确认弹窗。

### 9.4 源码编辑：不受可回写性限制的逃生通道

**结构化编辑（§9.1–9.3）和源码编辑是两件事，都要有。**

| | 结构化编辑 | 源码编辑 |
|---|---|---|
| 入口 | Inspector 表单字段 | 代码面板 |
| 能改 | 被解析出来的 `rules[]` | **任何代码，包括节点逻辑、控制流** |
| 受可回写性限制 | ✅ 受限 | ❌ 不受限 |
| 是否需要重启子进程 | prompt 类不需要（走 override）；写盘后需要 | **总是需要** |
| 场景 | 快速试探 prompt | 修 bug、加分支、改逻辑 |

> ⚠️ **澄清一个容易误读的点**：`writability = "runtime_computed"` 的意思是「表单那条捷径用不了」，**不是**「这段代码改不了」。用户随时可以在源码编辑器里改那段计算逻辑。可回写性分析约束的是便捷层，不是能力边界。UI 文案要写清楚这一点——标 ⚡ 的字段旁边给一个「改源码」的跳转。

**我们不做编辑器。** 源码编辑有两个出口，都不由我们承担：

1. **AI**（主要）——通过 MCP 让 Claude Code 改。`get_rendered_prompt` 给它看清现状，改完 `rerun_from` 验证
2. **用户自己的编辑器**（次要）——页面上标 ⚡ 的字段旁给「在编辑器中打开」，深链 `vscode://file/path:line`（§4.3）

所以「可回写性」的限制在 v0.5 下更加只是便捷层的事：表单改不了的东西，让 AI 改就行，它不受任何限制。

### 9.5 三个写入源的同步

```
① 页面上的结构化编辑  ─┐
② AI（Claude Code）   ─┼─▶  磁盘上的 .py 文件（唯一权威）
③ 用户自己的编辑器    ─┘            │
                                      │ watchdog 文件监听
                                      ▼
                        重新静态解析 → 更新 Graph IR → 页面自动刷新
                        若子进程在跑 → 页面提示「运行中的是旧代码」+ 重启按钮
```

**文件永远是唯一权威。** 这顺带消除了 imported 模式下「画布和代码谁说了算」的问题——永远是代码。

- 文件监听用 `watchdog`，去抖 300ms，忽略 `.agentmake/`、`__pycache__`、`.git`
- 结构化编辑写盘时打抑制标记，避免触发自己
- **AI 改代码是高频事件**：Claude Code 一次任务可能连改十几个文件，去抖窗口要够（500ms）并做批量重解析，否则页面会疯狂闪烁
- 代码变更后**不热重载**（见 §5.2），子进程需重启；页面顶部常驻显示新旧代码是否一致

### 9.6 画布创作的代码生成（authored 路径）

画布创建的 agent，平台拥有整个文件所有权：

```python
# agentmake:generated v3 — 由 AgentMake 画布生成
# 手动修改此文件会在下次同步时被覆盖。
# 需要自定义逻辑请写在 nodes_custom.py 并在画布上引用。
from langgraph.graph import StateGraph, END
from .state import TicketState
from . import nodes_custom

builder = StateGraph(TicketState)
builder.add_node("analyze", nodes_custom.analyze_ticket)
...
graph = builder.compile()
```

**画布只生成"骨架"（拓扑 + state + prompt 常量），节点内部逻辑引用用户手写的函数。** 不试图用画布表达任意 Python——那会走向图灵完备的可视化编程，是个泥潭。

节点的 prompt 生成为模块级常量，这样它们天然是 `static_literal`，回写路径和 imported 完全一致：

```python
ANALYZE_SYSTEM_PROMPT = """你是一个工单分析助手…"""
```

保护区域（`# agentmake:user-code` … `# agentmake:end`）留到 v2。

### 9.7 双向同步的所有权规则

| 模式 | 权威 | 画布编辑 | 代码被外部改了 |
|---|---|---|---|
| `imported` | **代码** | 生成 pending diff，需 review | 重新解析，画布跟随 |
| `authored` | **画布** | 直接重生成整个文件 | 检测到 hash 不符 → 警告并让用户选择「以代码为准重新导入」或「用画布覆盖」 |

**禁止中间态**。一个项目必须明确是哪种模式，不允许「有时候画布说了算，有时候代码说了算」——那是所有双向工具翻车的地方。

---

## 10. Provider 归一化（Gemini / Claude / OpenAI）

### 10.1 双向归一化

v0.2 只需单向（我们构造请求）。现在需要**双向**：拦截到原生请求 → 转 IR 给 UI 展示和编辑 → 用户改完 → 写回原生格式发出去。

```
native_request ──normalize──▶  LLMRequestIR  ──▶ UI 展示/编辑
                                    │
       原生格式 ◀──denormalize──  改过的 IR
```

```python
@dataclass
class LLMRequestIR:
    provider: str
    model: str
    system: str | None                 # 归一化后的系统提示
    messages: list[MessageIR]          # role: user|assistant|tool
    tools: list[ToolDefIR]
    params: dict                       # temperature 等，按能力矩阵过滤
    raw: dict                          # ★ 原始载荷，保留我们不认识的字段
```

### 10.2 三家的形状差异

| | Gemini (`google-genai`) | Claude (`anthropic`) | OpenAI |
|---|---|---|---|
| 入口 | `models.generate_content` / `_stream` | `messages.create` / `.stream` | `chat.completions.create` |
| 系统提示 | `config.system_instruction` 独立字段 | 顶层 `system` | messages 里 `role:"system"` |
| 助手角色名 | **`model`** | `assistant` | `assistant` |
| 消息内容 | `Content(parts=[Part(...)])` | content block 数组 | string 或 parts |
| 工具定义 | `tools=[{function_declarations:[...]}]` 多嵌一层 | `tools=[{name, input_schema}]` | `tools=[{type:"function", function:{...}}]` |
| 工具结果 | `Part.from_function_response(...)` | `tool_result` block | `role:"tool"` 消息 |
| 思考 | `thinking_config` + `part.thought` 标记 | `thinking:{type:"adaptive"}`，Opus 5 仅摘要 | reasoning summary |
| 采样参数 | `config.temperature` 等 | **Opus 5 不接受 temperature/top_p/top_k** | 接受 |
| 结构化输出 | `response_schema` | `output_config.format` | `response_format` |

### 10.3 保守合并原则

denormalize 时**只回写用户实际编辑过的路径**，其余字段从 `raw` 原样透传。

```python
def denormalize(provider, original_native, ir, edited_paths):
    out = deepcopy(original_native)
    for path in edited_paths:                  # 只动这些
        writer = WRITERS[provider][path]
        writer(out, ir)
    return out
```

理由：用户的项目可能用了我们不认识的参数（`safety_settings`、`cached_content`、自定义 `generation_config`）。全量重建请求会把它们丢掉，导致「一进调试器行为就变了」——调试器最不能犯的错。

### 10.4 能力矩阵仍然需要

UI 上编辑模型参数时，按当前 provider+model 过滤可编辑项。给 `claude-opus-5` 加 `temperature` 会直接 400，必须在 UI 层拦住。矩阵内容沿用 v0.2 §5.2。

---

## 11. 事件协议

沿用 v0.2 的设计，SSE + `Last-Event-ID` 续传，事件类型调整为调试器语义：

```typescript
type Event =
  // 会话与进程
  | { type: "session.started";  projectId: string; graphIr: GraphIR }
  | { type: "session.proc_log"; stream: "stdout"|"stderr"; text: string }
  | { type: "session.crashed";  exitCode: number; traceback: string }

  // 图层
  | { type: "node.entered";  node: string; checkpointId: string; state: State }
  | { type: "node.exited";   node: string; stateDiff: Patch[]; durationMs: number }
  | { type: "edge.taken";    from: string; to: string; via?: string }

  // 调用层
  | { type: "llm.before";  callId: string; node: string; request: LLMRequestIR }
  | { type: "llm.delta";   callId: string; kind: "text"|"thinking"; text: string }
  | { type: "llm.after";   callId: string; response: LLMResponseIR; usage: Usage; costUsd: number }
  | { type: "tool.before"; callId: string; name: string; args: unknown }
  | { type: "tool.after";  callId: string; result: unknown; isError: boolean }

  // 断点与干预
  | { type: "paused";   at: BreakpointRef; reason: "breakpoint"|"step"|"user" }
  | { type: "resumed" }
  | { type: "patched";  at: BreakpointRef; scope: "once"|"run"|"source"; diff: Patch[] }
  | { type: "faked";    callId: string; kind: "llm"|"tool" }

  // 时间旅行
  | { type: "rewound";  toCheckpoint: string; newBranch: string }

  // AI 活动（让页面能解释「画布为什么自己动了」）
  | { type: "mcp.tool_called"; tool: string; args: unknown; client: string }
  | { type: "source.changed";  files: string[]; by: "ai"|"user"|"platform" }
```

`patched` / `faked` 与执行事件在同一条时间轴上，保证 trace 自解释——用户能看到「我在这一步伪造了工具返回值，所以后面走了另一条分支」。

---

## 12. 数据模型（SQLite）

```sql
create table projects (
  id text primary key, name text, root_path text unique not null,
  config text,                        -- agentmake.toml 解析结果
  mode text not null,                 -- imported | authored
  last_ir text,                       -- 上次解析出的 Graph IR
  last_scanned_at text
);

create table sessions (
  id text primary key, project_id text references projects(id),
  status text not null,               -- starting|idle|running|paused|crashed|closed
  pid integer, harness_version text, langgraph_version text,
  thread_id text,                     -- LangGraph thread
  started_at text, ended_at text
);

create table runs (
  id text primary key, session_id text references sessions(id),
  input text, status text,
  root_checkpoint text, final_checkpoint text,
  parent_run_id text references runs(id),   -- rewind fork
  branch_from_checkpoint text,
  usage text, cost_usd real,
  started_at text, ended_at text
);

create table events (
  id integer primary key autoincrement,
  run_id text references runs(id), seq integer,
  type text not null, payload text not null, created_at text
);
create index idx_events_run on events(run_id, id);

create table calls (                  -- LLM/工具调用，便于按调用维度查询与重放
  id text primary key, run_id text references runs(id),
  node text, kind text,               -- llm | tool
  provider text, model text,
  request_ir text, response_ir text, raw_request text,
  request_hash text,                  -- 重放缓存键
  was_faked integer default 0, was_patched integer default 0,
  usage text, cost_usd real, duration_ms integer
);
create index idx_calls_hash on calls(request_hash);

create table pending_edits (
  id text primary key, session_id text references sessions(id),
  file text not null, loc text not null,     -- 精确源码坐标
  rule_kind text, old_value text, new_value text,
  writability text, applied_at text
);
```

大 payload（长 prompt、大工具输出）超过 64KB 外置到 `.agentmake/blobs/`，库里存引用。

---

## 13. 前端：常驻监视屏

React 19 + React Flow + Zustand + TanStack Query + Tailwind，浏览器直连 `127.0.0.1:8787`（REST + SSE）。

**设计前提：这是一块常驻在第二屏的监视器，不是一个你偶尔打开的工具。** 由此推出几条不同于普通 Web 应用的要求：

- **被动监视**：任何来源的运行（AI 跑的、你跑的、页面点的）都自动出现，不需要用户先在页面上「开始」
- **无空状态焦虑**：没有运行时显示上一次的结果和图结构，而不是一片空白
- **信息密度优先**：常驻意味着用户是余光扫，关键状态（在跑/暂停/失败/成本）要一眼可辨
- **不抢焦点**：不弹模态框、不自动滚动到底部（除非用户处于「跟随」状态）

| 面板 | 内容 |
|---|---|
| **Canvas** | 从 IR 渲染；跑过的节点/边高亮，未覆盖分支灰显；节点角标显示调用次数与成本 |
| **Trace** | 三层折叠树（节点 › 调用 › 内容），虚拟滚动；点击可深链到编辑器 |
| **Inspector** | 选中节点的 `rules[]` + 可回写性标记；就地编辑 + 作用域选择；⚡ 字段给「在编辑器中打开」 |
| **State** | 当前 checkpoint 的 state，JSON 树 + diff 高亮；可编辑（走 `update_state`） |
| **Timeline** | checkpoint 历史 + 运行树（fork 分支并排对比） |
| **Changes** | 本次会话改过的文件聚合 diff（含 AI 改的），可批量回退 |
| **Console** | 用户子进程的 stdout/stderr |

**AI 活动的可见性**（v0.5 新增）：MCP 调用要在页面上留痕——「Claude Code 刚刚调用了 `rerun_from(ckpt_3)`」应该出现在时间轴上。否则你会看到画布自己动起来却不知道为什么。这条和 §11 事件协议里的 `mcp.tool_called` 事件对应。

**性能**：一次长 run 上万条事件。事件用 `requestAnimationFrame` 批量 flush；文本 delta 累积在 ref buffer 节流写入；Trace 虚拟滚动；超阈值的历史事件按需分页拉取。

---

## 14. 安全

本地自用 + 执行用户自己的代码 → 威胁模型很轻，但有几点不能忽略：

- **我们在执行用户代码**，这是设计意图，不是漏洞。但要防误伤：apply patch 前强制备份 / 检查 git 状态
- **子进程隔离**：跑在用户 venv，不继承 Debugger 的敏感环境变量；`env_file` 明确声明才注入
- **密钥不入库**：拦截到的 request 里可能含 API key（某些 SDK 把 key 放 header，不在 body，但要主动脱敏 `Authorization` / `x-goog-api-key` / `x-api-key`）
- **blob 目录权限** 0700；提示用户 `.agentmake/` 加进 `.gitignore`
- **只绑回环**：Debugger Server 只监听 `127.0.0.1`

---

## 15. 目录结构

```
agentmake/
├── docs/ARCHITECTURE.md
├── server/                          # Debugger 后端
│   ├── app/
│   │   ├── main.py
│   │   ├── api/         projects.py sessions.py runs.py events.py
│   │   │                control.py edits.py source.py canvas.py
│   │   ├── mcp/         ★ MCP server（与 api/ 共用 service 层，不重复实现）
│   │   │   ├── server.py        stdio 传输 + 工具注册
│   │   │   ├── tools_read.py    get_graph / find_failures / get_rendered_prompt …
│   │   │   ├── tools_write.py   run_agent / rerun_from / patch_rule / fake_tool_result
│   │   │   └── summarize.py     token 预算控制与截断
│   │   ├── project/     discover.py  config.py  venv.py  watcher.py  hook.py
│   │   ├── introspect/  libcst_scan.py  ir_builder.py  writability.py
│   │   ├── session/     process.py  rpc.py  lifecycle.py
│   │   ├── codegen/     patcher.py  generator.py  diff.py  backup.py
│   │   ├── providers/   ir.py  gemini.py  claude.py  openai.py  capabilities.py
│   │   ├── store/       models.py  repo.py  blobs.py
│   │   └── core/        events.py  config.py  telemetry.py
│   └── tests/
│       └── fixtures/projects/       # 各种形态的 LangGraph 样例项目
├── harness/                         # 装进用户 venv 的轻量包
│   ├── pyproject.toml               # 近乎零依赖
│   └── agentmake_harness/
│       ├── __main__.py              # 子进程入口
│       ├── rpc.py                   # 手写 JSON-RPC over stdio
│       ├── loader.py                # import 用户模块、取 graph
│       ├── compile.py               # 注入 checkpointer + interrupts
│       ├── callbacks.py             # LangChain BaseCallbackHandler
│       ├── patch/  gemini.py  anthropic.py  openai.py
│       ├── intercept.py             # 阻塞式断点
│       ├── autoattach.py            # .pth 钩子入口（极度克制，静默失败）
│       └── compat.py                # LangGraph 版本探测
└── web/                             # 常驻监视屏（React SPA）
    └── src/  canvas/ trace/ inspector/ state/ timeline/ changes/ console/
```

---

## 16. 分阶段计划

### Phase 0 — 打通「看得见」（1 周）

- Project 发现 + `agentmake.toml` + venv 探测
- Harness 骨架：JSON-RPC 握手、import 用户 graph、`get_graph()` 上报
- Debugger：Graph IR 构建（仅拓扑，无源码坐标）
- Web：React Flow 渲染静态图
- **验收**：指向一个真实 LangGraph 项目，浏览器里出现它的结构图

### Phase 1 — 打通「跑起来看」（1.5 周）

- **附着模式**：`.pth` 自动附着 + `agentmake install-hook` / `uninstall-hook`
- Harness 驱动 `astream`，上报节点进出与 state diff
- LangChain callbacks + Gemini SDK patch（先做 Gemini，你的主力）
- 事件协议 + SSE + 三层折叠 Trace
- 成本与 token 统计
- **验收**：在终端里（或让 Claude Code）跑 `python main.py`，浏览器页面上实时出现画布高亮和完整的 Gemini request/response——**全程没在页面上点过任何按钮**

### Phase 2 — 打通「停下来」（1.5 周）

- 全节点 interrupt + 动态断点集合
- 六类断点、单步、继续、取消
- State 查看与编辑（`update_state`）
- 阻塞式 LLM/工具拦截
- **验收**：在某节点前停下，改 state，继续，行为改变

### Phase 3 — 打通「改规则」（1.5 周）

- LibCST 静态解析 → `rules[]` 源码坐标
- 可回写性分析与 UI 标注（⚡ 字段旁的「改源码」跳转 → `showTextDocument`）
- 三种作用域的修改（一次 / 本次运行 / 写回源码），写盘含语法校验 + 备份 + mtime 冲突检测
- **文件监听**（`workspace.createFileSystemWatcher`）→ 重解析 → 刷新画布
- 伪造 LLM 响应、伪造工具返回值
- 归一化双向映射（Gemini + Claude）
- **验收**：① 暂停 → Inspector 改 system prompt → 继续 → 行为变化；② 点 ⚡ 字段深链到编辑器，改完保存 → 页面自动刷新 + 提示重启；③ 伪造一个工具错误，验证走了异常分支

### Phase 4 — 时间旅行与回写（1 周）

- checkpoint 历史 UI、rewind、运行树与分支对比
- 重放缓存
- pending edits → unified diff → review → apply（含备份与 mtime 校验）
- **验收**：回到第 5 步改 prompt 重跑，并排对比两个分支；把满意的修改 apply 回源码，git diff 正确

### Phase 4.5 — MCP Server（4~5 天）★ 差异化

调试器核心跑通后再做——它消费的是前四个 Phase 已产出的 trace 数据与控制能力，**几乎没有新的后端逻辑**，只是把 service 层换一个协议暴露出去。

- MCP server（stdio）+ 工具注册；`.mcp.json` 配置片段与安装说明
- 感官工具：`get_graph` / `list_runs` / `get_run_summary` / `find_failures` / `get_rendered_prompt` / `get_state_at` / `get_step_detail` / `get_coverage`
- 控制工具：`run_agent` / `rerun_from` / `patch_rule` / `fake_tool_result` / `compare_runs`
- Token 预算控制：摘要优先 + 按需钻取 + `max_chars` 截断
- `mcp.tool_called` 事件 → 页面时间轴留痕
- **验收**：对 Claude Code 说「这个 agent 处理紧急工单时优先级判断错了，修一下」，它能自己 `run_agent` → `find_failures` → `get_rendered_prompt` 定位到 prompt 里历史被截断 → 改代码 → `rerun_from` 验证；全程你在页面上看得见它每一步在干什么

### Phase 5 — 画布创作（1.5 周）

- 画布编辑 → IR → LangGraph codegen
- `authored` 模式的文件所有权与同步规则
- 节点模板库（常见 LangGraph 模式）
- **验收**：从零画一个三节点 agent，生成的代码能脱离平台独立 `python -m` 跑起来

### Phase 6 — 打磨

OpenAI provider、非 LangGraph 兜底模式、覆盖率视图、批量回归、导出报告。

**可选回归项**（后端完全不变，随时可加）：

- **VS Code / Cursor 插件**：把页面搬进 webview，并加回 Hover 显示渲染后 prompt、CodeLens 显示调用成本这些编辑器内增强
- **DAP 适配器**：把 LangGraph 节点映射为栈帧、state 映射为变量，复用编辑器原生调试 UI。阻抗不完全匹配（「LLM 调用前」断点在行断点模型里不好表达）

---

## 17. 关键决策记录

| # | 决策 | 理由 | 否决方案 |
|---|---|---|---|
| 1 | **统一到 LangGraph 单一运行时**，画布创作走 codegen | 避免两套执行语义发散；画布产物可带走 | 自研引擎跑画布图 |
| 2 | **不重造执行/断点/时间旅行**，用 LangGraph 原生能力 | 它的 state 显式可序列化、checkpointer 和 interrupt 都是内置的 | 自研 checkpoint |
| 3 | **子进程 + 用户自己的 venv** | 依赖隔离；可 kill/重启；用户代码崩溃不影响 Debugger | 同进程 import |
| 4 | **stdio JSON-RPC**，不用 HTTP | 天然私有、无端口分配、无需鉴权 | 本地 HTTP / socket |
| 5 | **三层插桩**（图层+链层+SDK层） | 混合写法的项目很常见，SDK 层保证零遗漏 | 只挂 callbacks |
| 6 | **全节点 interrupt + 控制层过滤** | 换来完全动态的断点 | 每次改断点重新 compile |
| 7 | **LibCST 而非 ast** | 保留格式与注释，能做外科手术式替换 | ast + unparse |
| 8 | **写盘用编辑器 undo 模型，不是 PR review 模型** | 本地自用+自己的代码+git，review-first 是把多人流程套到单人工具上；安全网是 git+自动备份 | 每次 apply 前强制 review（v0.3 初稿的设计，已否决） |
| 8b | **结构化编辑 + 源码编辑并存** | 可回写性只约束便捷层；用户必须永远有直接改代码的通道 | 只提供表单编辑 |
| 8c | **文件是唯一权威**，平台用 watchdog 跟随 | 三个写入源（页面表单 / AI / 你的编辑器）不能互相覆盖 | 平台内缓存一份代码副本 |
| 14 | **不做任何编辑器**（v0.5 修订） | 面向 AI 编程：用户的编辑器是 AI。「编辑器」这个问题应该消失而不是被解决 | 自建 Monaco+LSP（+4~5 周）／VS Code 扩展（+1~2 周） |
| 15 | **同时做 MCP Server**，让 AI 拥有运行时感官 | AI 改 agent 时只能读代码猜，而 bug 大多在「实际发出的 prompt」里——那是读代码推不出来的。这是 v0.5 的核心差异化 | 只做人看的页面 |
| 16 | **MCP 工具摘要优先、按需钻取**，不提供 `get_full_trace` | 完整 trace 十万 token 级，一次倾倒会撑爆 AI 上下文 | 直接返回全量 trace |
| 17 | **附着模式为主，托管为辅** | AI 会自己 `python main.py`，不经过我们的启动器；`.pth` 自动附着做到零侵入 | 只支持平台托管启动 |
| 18 | **不内置 AI 对话框** | 用户已有 Claude Code；再造一个弱化版是重复建设，且永远追不上 | 页面内置 AI 助手 |
| 19 | **MCP 调用要在页面时间轴留痕** | 否则用户会看到画布自己动起来却不知道为什么 | AI 操作静默执行 |
| 20 | **页面是被动监视器**，不要求用户先点「运行」 | 常驻第二屏的定位决定了它必须自动反映任何来源的运行 | 页面驱动运行 |
| 9 | **可回写性诚实标注**，且标注旁给「改源码」跳转 | 「改了以为存下了其实没有」会毁掉信任；但不能让用户以为改不了 | 假装都能改 / 让用户以为无解 |
| 10 | **保守合并**：denormalize 只写用户改过的路径 | 保留我们不认识的字段，避免「一进调试器行为就变」 | 全量重建请求 |
| 11 | **模式二选一**（imported / authored），禁止中间态 | 双向同步的所有权必须唯一，否则必然冲突 | 智能双向合并 |
| 12 | **不做代码热重载** | Python 热重载在真实项目里不可靠，重启 2 秒更划算 | importlib.reload |
| 13 | **画布只表达骨架**，节点逻辑引用手写函数 | 不走向图灵完备的可视化编程 | 画布内写完整逻辑 |

---

## 18. 主要风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| **LangGraph API 在版本间变动** | Harness 大面积失效 | `compat.py` 做版本探测，不兼容时明确报错而非静默降级；CI 跑多版本矩阵 |
| **SDK monkey-patch 脆弱** | 漏掉部分调用 | patch 失败降级为 callback-only 并在 UI 明示「观测覆盖度」；不让它导致 session 崩溃 |
| **可回写率太低** | 表单编辑覆盖不到大部分 prompt | 源码编辑器兜底（永远可用）；先拿真实项目摸底统计；提供「把 prompt 抽成模块常量」的一键重构来提升可回写率 |
| **写盘破坏用户代码** | 灾难性，直接失去信任 | 写前语法校验 + mtime 冲突检测 + 自动备份（保留 50 次）+ 一键撤销；结构化编辑先只支持字符串字面量这种最安全的改动 |
| **托管执行的环境地狱** | 用户项目跑不起来，第一步就卡死 | 复用用户已有 venv 而非重建；失败时给出可操作的诊断（缺哪个包、哪个环境变量） |
| **两种模式的产品复杂度** | 用户搞不清自己在哪个模式 | UI 上强区分；imported 项目的画布只读元素明确置灰 |

---

## 19. 待确认

1. **你的 LangGraph 项目的 prompt 主要怎么写的**？直接内联在节点函数里的字符串字面量，还是 `ChatPromptTemplate`、还是外部文件？这直接决定可回写率，也决定 Phase 3 的解析器优先支持哪种形态。**这个答案对项目成败影响最大，建议先拿一个真实项目给我看看结构。**
2. **是否用了 LangGraph 的 `Send` API / 子图 / 多 agent（supervisor 等）**？这些会让静态拓扑和实际执行差异变大，可视化要额外处理。
3. **单图节点量级**？决定画布是否需要分组折叠。
4. Claude / OpenAI 的优先级——先只做 Gemini 够不够跑通 Phase 1–3？
