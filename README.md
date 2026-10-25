# AgentMake

**Agent 可视化调试器** —— 看到 agent 实际发出去的每一个 prompt，把它停下来改，控制它的循环。零侵入，被调试代码一行不用改。

支持 **Node / Python** 的完整接入（有调用栈、能控循环），以及**任何其它语言**的代理接入（改一个环境变量）。

## 解决什么问题

Agent 的 bug 大多藏在「**实际发出去的 prompt 到底长什么样**」里 —— 那是模板拼接、列表截断、变量展开之后的最终形态。读代码推不出来，AI 也推不出来。

第二类 bug 藏在**循环**里：那条 fallback 分支从来没走到、循环偷偷跑了 12 轮、重试悄悄多打了 3 次模型。这些在日志里全是「成功」。

AgentMake 把这两类都显示出来，并且让你**在运行中改**。

## 快速开始

需要 Node ≥ 22.6（用到内置 `node:sqlite` 与原生 TypeScript 类型剥离，**无需构建步骤**）。
唯一的运行时依赖是 `acorn`（源码回写与循环插桩要定位字节坐标），其余全用 Node 内置能力。

```bash
npm install
npm start          # → http://127.0.0.1:8787
```

浏览器打开后，**选了才监控**：点 **「检测本机 agent」**，它列出本机正在跑的 agent，选哪个就只记哪个。

| 列表里的 agent | 点「监控」会做什么 |
|---|---|
| Node 程序（dsh 等），没带探针 | **不重启**，让它打开调试口（SIGUSR1）、经调试协议装上探针，装完立刻关掉调试口。只记挂上之后的调用；循环插桩要在启动时装，这种挂法没有 |
| Python 程序，没带探针 | **重启并挂上**（先确认）：结束它，用原来的命令、目录、环境变量重新起，带上探针；输出改写到 `.agentmake/logs/` |
| 已经带着探针的（终端里手动加了 `NODE_OPTIONS` / `PYTHONPATH`） | 记下它的 pid，开始记 |
| Codex | 读它的会话记录（见下面），选补读今天 / 3 天 / 7 天 |
| Claude Code 等原生程序 | 列出来但接不了（读它会话记录的接入还没做） |

认 agent 靠进程本身：已知的程序名（dsh、aider、Codex…），或者它所在项目的依赖里有模型 SDK（openai、@anthropic-ai/sdk、langchain…）。
没认出来的 Node / Python 进程收在「其它进程」里，也可以直接选。不看网络连接 —— 走代理时看到的目标地址全是代理的。

**没选的不记**：带着探针的进程就算连上来，事件也不落库，断点也不拦它。监控中的进程拉起的子进程跟着记；
「停止监控」之后不再记，已经记下的保留。照「自己在终端里启动」给的命令起的（带 `AGENTMAKE_WATCH=manual`）、
导入的项目点 ▶ 起的，都算你选的。`AGENTMAKE_RECORD_ALL=1` 回到以前那样什么都记。

也可以让 AgentMake 来启动：

1. 点 **「+ 导入项目」**，在目录树里选中你的工程目录
2. 它会认出入口（`server.mjs` / `main.py` / …）并给出启动命令 —— 认错了当场改
3. 点 **▶**。探针由调试器注入，**你的代码一行不用改**
4. 常驻服务型的 agent 再填一条**触发命令**（一条 `curl` 就够），点 **⚡ 触发**让它真的干活

一次性脚本点 ▶ 就跑完了；常驻服务点 ▶ 只是把它 boot 起来，所以才有 ⚡。

**常驻服务按请求切分**（Node）：每个入站请求是一次独立的运行，挂在进程下面，标着触发它的请求（`POST /api/dispatch`）。
看某个请求就选那个请求；选进程等于看它处理过的所有请求。不碰模型、不发请求的（健康检查、静态文件）不会冒出空运行。
`AGENTMAKE_REQUEST_RUNS=0` 关掉切分。

**运行组**：`AGENTMAKE_GROUP=<名字>` 把一批运行归到一起（比如一轮回归）；缺省时组就是进程自己。

**子进程**：探针随 `NODE_OPTIONS` / `PYTHONPATH` 传给被调试程序拉起的每个子进程（Node、Python 都算）。
子进程记着是谁拉起的它，挂在父运行下面显示、归进父运行的组，页面不会自动跳过去 ——
在请求里拉起的（比如 dsh 某一轮对话里用 bash 跑的 `npm test`）记到那次请求上。
例外是父运行自己不调模型的包装进程（`npm start` → `node agent.mjs`）：那时跟随的就是子进程。
不想观测子进程（agent 会跑测试、构建之类的命令）就设 `AGENTMAKE_CHILDREN=0`，子进程完全不带探针。
**重放基线**：`AGENTMAKE_REPLAY` 可以给一次运行、一个进程（连同它的请求）或一个组。
重放出来的运行会记住基线，`compare_runs` 只给 runB 就能比；常驻服务的请求会对上基线里「同一触发请求的同一次」。

### 或者自己在终端里启动

```bash
agentmake attach          # 打印下面这些命令（路径已经拼好）

# Node
NODE_OPTIONS="--import /abs/path/agentmake/src/harness/register.ts" node your-agent.mjs

# Python（httpx / requests / urllib 都拦得到，不用装包）
PYTHONPATH="/abs/path/agentmake/src/pyharness" python your_agent.py
PYTHONPATH="..." python -m agentmake your_agent.py    # 入口脚本里的循环也要控制时

# 任何其它语言：只改 base URL
OPENAI_BASE_URL=http://127.0.0.1:8787/p/openai/v1     <你的启动命令>
ANTHROPIC_BASE_URL=http://127.0.0.1:8787/p/anthropic  <你的启动命令>
```

### Codex：读它自己的会话记录

Codex 是原生程序（不是 Node / Python），挂不上探针；用 ChatGPT 账号登录时它直连 `chatgpt.com/backend-api/codex`，
代理也接不了。但 Codex 把每次会话完整写在 `~/.codex/sessions/**/rollout-*.jsonl` 里 ——
在「检测本机 agent」里选了 Codex 之后，补读最近几天改动过的会话，之后有新会话、新内容就接着读（AgentMake 重启后接着读），
只读、不碰 Codex 的配置和登录凭据。没选就不读。

- 一个会话 = 一个运行（历史栏里是「codex desktop · 目录」一批），里面每轮对话一条，任务就是你发的那句话
- 一次模型回答 = 一次调用：输入是这一轮到此为止的对话，输出是它说的话和发起的工具调用（token 照 Codex 记的）。
  流程、时序、完整记录、循环图都能看；`exec` 里的命令按读 / 跑 / 写 / 测试归类，`"exit_code":N` 不为 0 算失败
- 子 agent（spawn_agent）和审查（guardian）挂在拉起它的那一轮下面，点开看它自己的记录
- 只能看：Codex 不经过 AgentMake，断点、改写、重放都没有；模型想完才落盘，时序里的「模型在想」是两次落盘之间的时间
- 不转发给 Langfuse（那是把本机所有 Codex 对话发到外面）；记录存在本机 `.agentmake/` 里，和 Codex 自己的记录一样
- `CODEX_HOME` 跟 Codex 一样

**选中的 agent 不管谁触发都会显示**：你在终端里用它、Claude Code 帮你跑、pytest 跑，都一样。

### 三种接入方式的差别

| | 看 prompt / 断点 / 改写 / 重放 | 调用栈（哪个函数发的） | 循环实时控制 |
|---|---|---|---|
| Node harness | ✅ | ✅ | ✅ |
| Python harness | ✅ | ✅ | ✅ |
| 代理（任何语言） | ✅ | ❌ 按 system prompt 归并成步骤 | ❌ |
| Codex（读会话记录） | 只能看 | ❌ 按它说的话切步骤 | ❌ |

## 现在能做什么

**看到实际发出的 prompt**
- 自动识别 **Gemini / Anthropic / OpenAI 兼容**（DeepSeek、智谱、Kimi、本地 vLLM、LiteLLM…）三类协议
- 展示**归一化后**的 system prompt、messages、tools、模型参数——三家协议差异被抹平
- 展示实际响应、finish reason、token 用量（含缓存命中）、耗时
- **工具调用结构化**：模型调了哪个工具、参数（解析成对象，写坏的 JSON 会标出来）、每条工具结果对应哪次调用 —— 只调工具不说话的回答也看得见
- 保留原始请求体，供对照

**实时观看：数据流、循环、规则判定都画在图上**

监视屏：最左边是**历史会话栏**，然后是「需要你看的」、中间数据流 + 时间线、右边**完整记录**。

- **流程 · 详细流程图**（agent 循环时）：调研了 Langfuse、LangSmith、Arize Phoenix、Datadog、AgentOps 的 agent 视图和
  TraceView、Agent ATO、Agent Trajectory Explorer 几篇论文之后取的做法：
  - **节奏条**（Agent ATO）：一格一轮，按这一轮做的事着色 —— 读 / 查看、执行、写文件、跑测试（按工具名和命令规则判）；
    失败 ▲、卡住 ⏸ 直接标在格子上。阶段从颜色里自己显出来。点一格跳到那一轮，拖选一段只看这段。
  - **三档详细程度**（Langfuse 的聚合 / 展开、TraceView 的概览 / 详细）：聚合（模型 ⇄ 工具的条形统计）、步骤（默认）、逐轮。
  - **步骤**：agent 每做一件新事先说一句打算，用这些话切步骤（dsh 那次 103 轮切成 35 步）。一句话常是前半句上一步的结论、
    后半句这一步的打算，所以标题取打算、「结果」取下一句里的结论。每步带一条动作类别的颜色条、耗时、轮次范围和标签：
    失败、卡住（两轮之间工具跑了 30 秒以上）、换路（说了「改用 / 换成」或杀掉了卡住的任务）、重复（同类命令跑了 3 次以上）、
    发现、通过。一路顺利的连续步骤收成一行，有异常的单独显示；可以只看有异常的步骤。不说话的 agent 退到按动作类别和长空档切。
  - **连线有含义**（TraceView 的语义连线，这里规则判）：推进细灰线、换路虚线、卡住红色粗线并写明时长。
  - **想 / 做 / 得**（TraceView、Agent Trajectory Explorer）：点开一步，逐轮显示模型说了什么、调了什么（按类别上色）、拿回什么
    （失败的标退出码）。悬停在步骤上直接看到它的结果。
  - **联动**：在节奏条、步骤、时序、完整记录任意一处选中某一轮，其余几处一起跳过去、高亮，流程里自动展开它所在的步骤。
  普通的流水线 agent（先抓数据再分析）仍是原来的步骤流程图。
- **时序**（agent 循环默认，中间栏顶上「流程 / 时序」切换）：一轮一行的瀑布图，所有行共用一条时间轴 ——
  蓝条是模型在想，后面的灰条是到下一轮开始之前的空档，单线程的 agent 循环里那就是它在本地跑工具（bash、读写文件）
  的时间，超过 30 秒标红。卡住的命令只在这里看得见：每次模型调用都正常，慢在两轮之间（dsh 跑浏览器测试挂了 120 秒，
  就是第 43 轮后面那一段红条）。旁路调用和 HTTP 请求按实际发生的时间插在中间；顶部汇总全程、模型时间、工具时间；
  最后一轮的工具还在跑时那一段会实时往右长。点一行，右栏打开那次调用。
  流程图按「步骤」归并，同一处代码反复调模型会并成一张「×103」的卡片、看不出先后，所以 agent 循环默认看时序；
  流程图里这种一列不再说「同时进行」，改说「穿插进行」。
- **完整记录**（右栏默认）：选中一次运行，右栏就按对话顺序把它铺开 —— 交给 agent 的任务 → 第 1 轮模型的回答
  和它发起的工具调用 → 工具结果 → 第 2 轮 …… 每次调用发出去的都是整段对话，这里只显示每轮**新增**的部分
  （上一轮的回答、前面的历史不重复），工具结果挂在发起它的那一轮里（命令和结果、报错在一起）；旁路调用（换了 system prompt 的，比如起会话标题）和普通 HTTP 请求按时间
  插在中间一行带过；框架拼在用户消息后面的运行时上下文折起来。点任意一轮的标题行 → 那次调用的完整 prompt、
  system prompt、工具定义、原始请求和原始响应，顶上一键回到完整记录。运行还在跑时实时往下长。

- **历史会话栏**（按批次的树）：第一层是**批次** —— 一次服务启动（dsh web 起来一次，下面是这次的每一轮对话）、
  一个显式的组（`AGENTMAKE_GROUP`），或同一目录里前后相隔不到 10 分钟的连续几次运行。收起时一行看清这一批的
  时间范围、几次、合计调用 / token / 失败和状态；默认只展开最新一批和正在看的那一批，搜索 / 筛选时命中的都展开。
  展开后每一条 = 一次干活，标题是那次交给 agent 的任务原文（第一条用户消息，框架拼在后面的运行时上下文会去掉），
  下面是时间、调了几次模型 / 工具、token、时长、失败数；圆点表示在跑 / 完成 / 有失败 / 中断。
  能搜任务、程序、模型，能只看有问题的或在跑的。服务批可以「整批放在一起看」。
  常驻服务（dsh web 这种）每一轮对话各自一条；被拉起的子进程挂在拉起它的那一条下面；一次模型都没调过的
  （健康检查、空进程、只抓数据的脚本）不列，只在底部报个数。打开页面默认显示最近一次干过活的那一条。
  左上角的按钮可以收起它。

- **数据流图**（从左往右是执行顺序）：连线上写的是**真实流过去的数据** ——
  `12 条 → 5 条 ✂`（上游给的列表，下游 prompt 里只出现了几条）、`3.1KB · 进了 prompt 42%`。
  这类 bug 每一步都是 200、日志里看不出来，只有把上游的输出和下游的输入摆在一起才看得见。
  工具调用的响应体（文本类，最多 256KB，`AGENTMAKE_BODY_BYTES` 可调、设 0 不读）异步读副本，不碰用户的流
- **正在跑的步骤会发光**并自己走秒；下游还没回来时线上先标「上游给了多少 · 等下游用」
- **规则判定直接挂在节点上**（`✗ 被截断 ×3`），数据丢失的线变琥珀色
- **循环逐轮轨道**：每轮一格，颜色是这一轮的结果，柱高是这一轮的 prompt 大小 —— 「从第几轮开始不对」「越转越大」一眼可见；
  离上限还有几轮画成虚格
- **需要你看的**（自动发现，按影响排序）：数据在进 prompt 前被丢掉、规则判定失败、调用失败、比平时慢（参照同一进程的其他请求）、
  循环比平时多转、同一个请求发了好几遍、工具返回空。点一条，图上只亮出相关路径，调用列表筛到那几次
- **时间线**：常驻服务每个请求一条泳道，并发一眼可见；有调用在跑时只看最近 30 秒，卡住的调用会一直往右长

**追查：顺着数据找到出错的那一行**

- **prompt 按来源拆开**（点任意一次模型调用，详情最上面）：每一段标着出处 —— 源码里的模板（文件:行，可写回）、
  来自哪次工具调用的第几条、来自前面哪一步模型的回答、运行时拼的。点一段就跳到产出它的那次调用（工具调用能看到原始响应体）
- **没进 prompt 的部分**单独列出来：「loadHistory 给了 12 条，只用了 5 条，缺的是 #1–#7」，原文逐条摆出
- **可疑代码**：在发起调用的那几层函数附近找截断写法（`slice(-5)` / `[:5]` / `truncate` / `limit`），注释和 `max_tokens` 这种限制输出的不算
- **同一步，跨请求看规律**（点节点或异常，图下面出表）：一行一个请求 —— 上游给了多少、用了多少、丢的是什么、输出、下一步、判定。
  表头自动总结规律：「上游数据被丢掉的 4 次都判成 normal、走 polish；没丢的 2 次都判成 urgent、走 escalate」
- AI 侧对应三个 MCP 工具：`get_anomalies` → `trace_prompt` → `compare_step`

**验证：改完到底有没有变好**（「更多 → 验证」，或重放出来的运行顶上点「和基线对比 ▸」）

- **结论**：两次运行的异常求差 —— 修好了哪几处、新冒出来哪几处、哪几处还在；真打模型几次、走缓存几次
- **逐步对齐**：按步骤名对齐（改代码会让行号漂、修好后常走另一条分支，按调用序号对齐会错位）。
  ★ 是第一处变化（注入点），之后的是连锁反应；每步标着「没变 / 变了 / 改之后没再执行 / 改之后第一次走到」。点一行，右边是这一步 prompt 和输出的逐行差异
- **批量回归**：探针在入站时旁听下了请求本身（方法、路径、请求体，最多 64KB，不改变流的读取方式），
  改好的服务带着探针重新跑起来后，一键把基线处理过的请求原样重发过去，逐个判「改对了 / 还有问题 / 没变坏 / 被改坏了」。
  重发的请求带着 `x-agentmake-baseline`，新运行一对一挂到它的基线请求上；没受影响的模型调用按这个基线命中缓存 ——
  目标服务不用开 `AGENTMAKE_REPLAY` 也只为变化的部分付钱
- AI 侧：`verify_run`（逐步对齐 + 单步差异）、`run_regression`（批量回归，等结果）

**看到 agent 在干什么（不是看函数调用图）**

顶部一句话说清这次运行做了什么：`抓了 11 次数据（同时进行），然后 问了模型 1 次 · deepseek-chat`。

下面是语义化的步骤流：
- **步骤** = 调用点（哪一行代码发的），同一行发出的调用归成一步，跑多少轮都是它
- **循环**画成容器，标着转了几轮、为什么停；点某一轮就看那一轮**实际发出去的内容**
- **分支**自动显形：在循环里但不是每轮都跑的步骤会被标出来 —— 它在 `if` 里
- **并发**横排 + 时间线，一眼看出哪里在并行、谁最慢
- 数字（耗时 / tokens / 源码位置）默认折叠，想深究再展开

图只反映跑过的路径：**没被覆盖到的分支不会出现**，这本身就是调试信息。
（函数调用图仍在，收在「更多 → 函数调用图」里。）

**控制循环 —— 不改代码、不重跑**

源码里写死的 `for (let i = 0; i < MAX; i++)` 在运行中就能改：

| 操作 | 效果 |
|---|---|
| **最多转 N 轮** | 源码 `MAX=5`，设成 2 就真的只跑 2 轮 |
| **现在就跳出** | 下一次判断直接结束 |
| **再转一轮** | 它本来要结束了，强行再跑一轮（Python 的 `for` 除外，迭代器耗尽没法复活） |
| **每轮停一下** | 停在轮次边界上，看完这一轮再决定继续还是跳出 |

实现是模块加载时改 AST（Node 用 acorn，Python 用标准库 `ast`），给循环装上可控的条件与轮次上报。插不上就原样放行 —— 把用户的程序改坏了是我们的锅，少一个功能只是少一个功能。

**停下来改**（这是和只读 tracing 工具的分界线）

四个断点位置，被调试进程真的阻塞在那里：

| 位置 | 能做什么 |
|---|---|
| **请求前** `llm.before` | 改 system / messages / 模型 / 参数；伪造响应；中止 |
| **响应后** `llm.after` | 改模型的回答——测下游代码遇到异常输出会怎样 |
| **工具前** `http.before` | 伪造工具返回值（状态码 + 响应体），不用真去制造故障 |
| **工具后** `http.after` | 改工具返回值 |

- 放行后**模型/用户代码收到的是改后的内容**（有 e2e 断言盯着，不是靠日志自证）
- 「放行并停下一次」= 单步；「只停一次」= 跑到下一次调用
- 可按执行图节点（`file#fn`）或 URL 子串过滤——工具断点几乎必须配 URL 过滤，否则会被信源抓取淹没

**改一版重跑，只为变化的部分付钱**

页面上点项目条的 **「重放」**，或者：

```bash
AGENTMAKE_REPLAY=<基线runId> NODE_OPTIONS="--import .../register.ts" node your-app.mjs
```

缓存键是**归一化请求的哈希**，于是理想行为自然落出来，不需要跟踪步号：

| | 结果 |
|---|---|
| 改动之前的调用 | 请求逐字节相同 → 命中缓存 → **不花钱、不等待** |
| 被改动的那次 | 请求变了 → 穿透缓存 → 真实调用 |
| 它之后的调用 | 上游输出变了 → 穿透缓存 → 真实调用 |

跑完用 `/api/compare?a=&b=`（或 MCP 的 `compare_runs`）看差异，它会指出**第一处分歧在哪** —— 那是改动的注入点，之后的差异都是连锁反应，别误读成新问题。

**把调好的 prompt 写回源码**

在 Inspector 里点「能改回源码吗？」，或用 MCP 的 `check_writability`：

| 结论 | 含义 |
|---|---|
| `static_literal` | 源码里就是这个字符串 → 精确替换 |
| `static_composed` | 模板拼接 → 静态片段可改，`${}` 插值不可改 |
| `runtime_computed` | 值来自变量/外部数据 → 定位不到唯一源码位置 |

> `runtime_computed` **不等于「这段没法改」**——它只是说没有捷径，你依然可以直接改产生它的那段代码。UI 与 MCP 文案都必须体现这点，否则用户会以为功能坏了。

实测 `news` 项目：那条 8576 字符的 user message 是 `static_composed`，7 个静态片段全部精确定位到 `press.mjs`。

写入有三重安全网，任一不过就整体放弃、文件保持原样：**内容哈希冲突检测**（分析后被别人改过就拒绝）、**写后真解析校验**（acorn 重新解析 + 回读确认）、**自动备份**（可一键撤销）。

**判断「改完有没有变好」**

HTTP 200 不代表答对了。被截断、什么都没说、工具参数是坏 JSON —— 这些在日志里全是「成功」。

- **规则判定**，落库时自动跑、零成本：被截断（`finish_reason=length` / `max_tokens` / `MAX_TOKENS`）· 空输出（没文本也没调工具）· 工具参数不是合法 JSON · 调了请求里没声明的工具 · 被安全策略拦截。老库启动时自动补判
- **AI / 人的判定**：`score_call` 记下「这次答对了没有」+ 理由，可打在调用上或整次运行上；同名再判是覆盖
- `find_failures` 同时列出 HTTP 失败和判定失败，每条写明为什么算失败
- `compare_runs` 按调用顺序对齐两边的失败判定，给出结论（变好 / 变差 / 有好有坏 / 没变化）以及修好了哪几处、新冒出来哪几处

评分的形状对齐 Langfuse 的 score（name / value / 来源 / comment，挂在 trace 或 observation 上），多一个明确的 `passed`。

**你以为它怎么跑 vs 它实际怎么跑**

「规格对账」标签页里画一份意图图（或者点「按实际运行生成草稿」拿个起点），跑一次之后对账：

| 差异 | 说明 |
|---|---|
| 画了但一次没跑到 | 死代码，或者进它的条件永远不成立 |
| 跑了但没画 | 藏着的重试？fallback？ |
| 实际顺序和连线反了 | |
| 循环超轮 | 你预期最多 3 轮，实际跑了 12 轮 |
| 没标成分支却只在部分轮跑 | |

绑定要**显式**：规格里写「评审」，实际步骤 id 是 `/abs/path/agent.mjs#review:12`。名字模糊匹配在中英混排、改名重构面前都会错，而对账一旦错配输出全是噪音 —— 还不如没有。所以同名唯一才自动绑，绑不上就给候选让你点一次，绑定长期有效。

这份规格同时是**给 AI 的规格**：比一段自然语言精确得多。

**给 AI 用（MCP）**

AI 改 agent 时是瞎的——它只能读代码猜运行时行为。把调试器接成 MCP server，Claude Code 就有了感官和手：

```bash
claude mcp add agentmake -- node /abs/path/to/agentmake/src/cli.ts mcp
# 或直接用仓库里的 .mcp.json
```

闭环：`get_spec`（你要什么）+ `get_flow`（它现在什么样）→ AI 改代码 → 跑一次 → `diff_spec` 拿到差异 → 继续改，直到差异清零。

答案质量的闭环：`find_failures` → `get_call` 看内容 → `score_call` 记下判错 → 改代码 → 带 `replayFrom` 重跑（没改的调用不花钱）→ 同名重判 → `compare_runs` 看「变好了」。

| 感官 | 手 |
|---|---|
| `find_failures` ★ 直接定位出错的调用+调用路径 | `set_breakpoint` 四个位置任选 |
| `get_call` ★ 实际发出的完整 prompt | `list_paused` 看谁被阻塞着 |
| `list_runs` / `list_calls` / `search_calls` | `resume` 放行，可同时改写 |
| `get_graph` 执行图 | `get_attach_command` 拿启动命令（可带 `replayFrom`） |
| `compare_runs` ★ 两次运行的差异与分歧点 | `check_writability` 能不能改回源码 |
| `get_flow` ★ agent 语义流程（步骤/轮次/分支/并发） | `apply_source_edit` / `revert_source_edit` |
| `list_loops` 循环及当前轮次 | `set_loop` 改上限 / 跳出 / 再来一轮 / 每轮暂停 |
| `get_spec` ★ 用户画的意图 | `set_spec` / `draft_spec_from_run` |
| | `score_call` ★ 记下判定：答对了没有、为什么 |
| `diff_spec` ★ 意图 vs 实际的全部差异 | `resume_loop` 放行停在轮次边界上的循环 |
| `get_anomalies` ★ 自动发现的异常（含数据丢失） | |
| `trace_prompt` ★ prompt 按来源拆开、缺了什么、哪行丢的 | |
| `compare_step` 同一步跨请求的表现与规律 | |
| `verify_run` ★ 改前改后按步骤对齐、注入点、结论、单步差异 | `run_regression` ★ 拿历史请求批量回归 |

Token 预算是硬约束：摘要优先、按需钻取、大文本可 `maxChars` 截断、**刻意不提供 `get_full_trace`**（一次长 run 的完整 trace 十万 token 级，会撑爆 AI 的上下文）。

**实时**
- SSE 推送，支持断线续传（`Last-Event-ID`）
- 新进程启动自动跟随

真实例子（`news` 项目，零代码改动）：

```
Server.<anonymous> ─ handleDispatch ─┬─×2─ compose  → chat     → …  (调模型)
                                     └─×14─ dispatch → mapLimit → scoutOne → fetchWithTimeout  (抓信源)
```

## 设计要点

**按请求形状识别，不按 SDK。** 目标项目直接裸调 `fetch`，没有 SDK 可 patch。拦 `globalThis.fetch` 天然框架无关——手写 agent、任何 SDK、自研 HTTP 封装都覆盖，且不受 SDK 版本漂移影响。

**以路径形状为主判据，host 只作辅助。** `:generateContent` 是 Gemini 独有的动作后缀，`/chat/completions` 是 OpenAI 兼容协议的标志。要求官方域名会导致用代理/网关时全部失效——而这在真实项目里很普遍。

**绝不弄坏用户的程序。** 拦截层的三条铁律：
1. 观测失败一律吞掉，异常原样抛回，行为与未拦截时完全一致
2. 上报不阻塞用户代码——入队即返回，后台批量发送
3. 调试器没起来就静默放弃，不重试风暴

**回写用真 AST 定位，但不做代码生成。** acorn 只用来拿「这段文本在文件的哪个字节区间」，替换是对原文的字节切片——未改动的部分逐字节保持原样，不会出现「格式化整个文件」这种灾难。多行内容会把普通字符串自动升级成模板字面量（普通字符串塞不下换行）。

**可回写性的门槛取低不取高。** 误报成「改不了」会让功能显得没用；而误配的风险由首尾锚定（值必须以首片段开头、末片段结尾）+ 写入前的语法与回读校验兜住。判据用静态文本**总量**而非单片段长度——中文信息密度高；也刻意不看「静态占比」，真实 prompt 常是几百字骨架套几千字检索结果，按比例卡会把最该支持的场景挡在外面。

**不采集请求头。** 密钥只可能出现在 header 里，那就干脆不收（`redactHeaders` 备用，将来真需要时再启用）。已验证数据库中零泄漏。

**重放缓存用内容寻址，不用步号。** 键是归一化请求的哈希，且**在断点改写之后**才计算——所以改了 prompt 指纹就变，自然穿透缓存去真调。哈希刻意排除 `raw`（含我们不认识的字段如 `cachedContent` 引用），否则缓存几乎永远打不中。基线查询排除 `replayed=1` 的行，防止缓存自我传递、越跑越说不清某份响应究竟出自哪次真实调用。

**执行图从调用栈推导。** Node 默认开启 async stack traces，`await` 链能完整保留——实测穿透了 `Promise.all` 并发（`mapLimit`）和重试包装（`withRetry`）。匿名内联回调帧被丢弃，否则会给图加一堆无语义的 `<top>` 节点。

**改写走保守合并。** IR→原生的反向映射只回写用户**实际编辑过**的字段，其余从原始请求体透传。全量重建会丢掉我们不认识的参数（`safety_settings`、`cached_content`、自定义 `generation_config`…），导致「一进调试器行为就变」——调试器最不能犯的错。改消息文本时按下标定位到原始消息对象，只替换其中的文本 part，图片 / `tool_result` / `cache_control` 原样保留。9 条单测盯着这两点。

**阻塞不等于卡死。** 断点挂起的实现就是「服务端不回复那个 HTTP 请求」。任何一条路径断了都会放行：调试器进程挂掉、页面关掉、连接断开、超时（默认 10 分钟）、关闭断点开关。实测杀掉调试器时被阻塞的 agent 立刻恢复。

## 目录

```
src/
  cli.ts      命令行入口（serve / mcp / attach）
  shared/     IR 类型 · 协议识别 · 归一化/反向映射 · 调用栈解析 · 请求指纹
  harness/    Node 探针：fetch 拦截 · 断点闸门 · 循环 AST 插桩（跑在被调试进程里）
  pyharness/  Python 探针：httpx/requests/urllib 拦截 · 调用栈 · 循环 AST 插桩
  server/     事件接收 · node:sqlite 存储 · SSE · 闸门
              flow      语义流程推导（步骤/轮次/分支/并发）
              spec      意图图与「意图 vs 实际」对账
              proxy     LLM 代理层（任何语言零改动接入）
              hook      语言无关的 harness 钩子 API
              projects  导入工程目录 · 启动/停止/触发 · 目录浏览
              jsscan · writability · patch —— 源码定位与回写
  mcp/        MCP server（手写 JSON-RPC，给 AI 用）
web/          常驻监视屏
test/         mock LLM · Node/Python fixture · 单测 · 13 个 e2e 套件
docs/         架构设计
```

`shared/` 被 Node harness 与 server 共用是刻意的：协议归一化是最琐碎易错的一块，跨进程写两遍必然腐化。

**Python 侧没有重写这一块。** 它通过 `/api/hook/*` 把「我要发这个请求」原样递给服务端，由服务端做协议识别、归一化、指纹和断点决策 —— 客户端只管抓栈和拦 HTTP。重写一遍的后果很具体：两边算出的 `requestHash` 不一样，跨语言重放永远打不中。代价是每次调用多一次本地往返（~1ms），而 Node harness 本来就要为闸门走一次往返。

## 开销

**LLM 调用**每次净增 ~0.9ms（一次本地闸门往返），相对模型本身的几百毫秒可忽略。断点关闭时同样要问一次——**correctness over micro-optimization**：缓存断点状态会让「点了断点但下一次调用没停」变成常态，在调试器里不可接受。

**普通 HTTP 调用**量级可能上千，所以只在确实开了工具断点时才走闸门。这里用了缓存标志，代价是要在安装时预取一次——否则短命进程的第一个 HTTP 调用发生在任何上报往返之前，缓存值必然是错的 false。

## 已知边界

**适用范围**

| | 能用 | 看不到 / 不支持 |
|---|---|---|
| Node | 全局 `fetch`（手写、新版 SDK）；`node:http` / `https`（axios、got、底层用 node-fetch 的旧版 SDK 如 openai-node v4，含 ESM 具名导入、gzip / br 压缩的响应） | `undici.request` 这类不经过全局 fetch 也不经过 `node:http` 的底层客户端 |
| Python | `httpx`（含 `stream=True` —— 官方 OpenAI / Anthropic SDK 的流式）/ `requests` / `urllib` / `aiohttp` | `requests` 的 `stream=True`（放行，不观测）；`aiohttp` 的「响应后断点」（只旁听、不能改写回答） |
| 其它语言 | 能改 base URL 就走代理接入 | 没有调用栈、没有循环控制；代理把流读完整段再转发（内容完整，但客户端看不到逐字出现） |
| 协议 | OpenAI 兼容 `/chat/completions`、OpenAI Responses API（`/v1/responses`、Azure 的 `/openai/v1/responses`）、Anthropic `/messages`、Gemini `generateContent` / `streamGenerateContent` —— 非流式和流式都解析 | Bedrock、Vertex 上的 Claude（rawPredict）、Ollama 原生 `/api/chat` —— 当成普通 HTTP |
| 常驻服务按请求切分、批量回归 | Node 的 http / https server | Python 的 FastAPI / Flask（一个进程一次运行，没有入站请求可重发） |

- **流式响应**：原样交给用户代码，旁听一份，流结束后把增量拼回完整的回答（正文、分片到达的工具调用参数、finish reason、usage）；
  重放时按原样回放成流。「响应后断点」对流式不生效 —— 流已经在往下游走了
- **`node:http` 的拦截**：模型调用的请求体会先攒到 `end()` 再发（断点可能要改写它）；非流式的响应先整段读完、过完「响应后断点」再交给用户。
  `AGENTMAKE_NODE_HTTP=0` 只关这一层
- **TypeScript 源码的回写** —— acorn 只解析 JS，`.ts` 文件会报 `unparsable`；prompt 来源拆解里的「模板」也只认 JS
- **`forceOneMore`（再转一轮）对 Python 的 `for` 无效** —— 迭代器耗尽了没法复活。`while` 不受影响，这是语言差异
- **`python foo.py` 时入口脚本里的循环插不上桩** —— 解释器直接编译它，不走 importlib。用 `python -m agentmake foo.py`（页面导入时会自动用这个）。被 import 的模块两种方式都能插桩
- **Python asyncio 不保留 async stack trace** —— 并发任务的调用链比 Node 浅
- **代理接入没有调用栈** —— 步骤按 `(模型 + system prompt 指纹)` 归并
- **不重启挂探针只对 Node 22.12+ 有效**（要能 require ES 模块、直接跑 .ts），而且要用固定的调试端口 9229 —— 被别的调试器占着时挂不上，改用「重启并监控」。
  挂上之后只记之后的调用，没有循环插桩
- **重启并监控**按 `ps` 看到的命令行重新起：参数里带空格的（路径里有空格）会被拆错；原来那个终端里不会再有它的输出
- **Codex 只能看**：读的是它写在本机的会话记录，断点 / 改写 / 重放都不支持；推理是加密的，看不到它想了什么，只看得到它说的话和做的事
- **画布拖拽生成 agent 还没做** —— 目前是「画布定意图 + AI 写代码 + 跑完对账」的路子

## 开发

```bash
npm start                # 调试器
npm run dev              # 同上，带 --watch
npm test                 # 222 条单测（本机 agent 扫描与选了才记 / 不重启挂探针 / Codex 会话记录接入 / 归一化 / Responses 与流式协议 / 重放指纹 / 工具调用 / 评分与规则判定 / 运行组与子进程 / 历史会话栏 / 完整记录 / 数据流与异常 / 追查 / 验证与回归 / 回写 / 循环插桩语义 / 流程推导 / 对账）
npm run test:e2e         # 13 个 e2e 套件，自己起 mock 和 server，跑完收摊（固定用 8787 / 8799，跑之前先停掉在用这两个端口的调试器）
npm run test:all
```

e2e 套件：`breakpoint`（断点真的改到了模型）· `mcp`（协议 + 全部工具）· `replay`（缓存与对比）·
`loop`（运行中改上限/跳出/强制多跑）· `proxy`（三协议 + 纯 Python agent 零改动）·
`spec`（对账闭环）· `python`（Node/Python 能力对齐，含 httpx 同步与异步并发）·
`toolcall`（工具调用与结果进 IR、工具结果变了重放必须穿透）·
`scores`（200 但被截断能被找到、AI 判定、改完重跑后对比得出「变好了」）·
`requests`（常驻服务按请求切分、并发不串、重启后以上一个进程为基线重放、运行组）·
`dataflow`（工单 agent：线上 12 条 → 5 条、规则挂在节点上、循环按请求数轮次、修好之后异常栏清空；
追查：prompt 来源拆解指到 `slice(-5)` 那一行、跨请求对比得出「丢了数据的判 normal、没丢的判 urgent」；
验证：改好的服务起来后批量回归，2 个改对、1 个没变坏且全走缓存，逐步对齐 ★ 在 analyze）·
`clients`（node:http / gzip / 读流 / 四种协议的流 / Responses API，带不带探针结果一字不差、重放 0 次真打、node:http 上的断点能改写能伪造；
二进制响应原样透传、`fetch(Request)`、读完流就 abort 自己的 signal、子进程归属与 `AGENTMAKE_CHILDREN=0`；
Python 的 aiohttp 与 httpx 流式要设 `AGENTMAKE_PY_DEPS` 指向装了 aiohttp、openai 的解释器，否则跳过）·
`security`（畸形 Host、DNS 重绑定、外站 Origin、源码回写 / 还原的路径限制）。

`python.e2e` 里 httpx 那一节在没装 httpx 时会**明说跳过**而不是静默略过；
`AGENTMAKE_PY_HTTPX=/path/to/venv/bin/python` 可以指定带 httpx 的解释器。

`run-e2e.mjs` 会先检查 8787/8799 是否被占用并**直接退出** —— 这个坑真踩过：
端口被一个残留的旧 server 占着，整轮测试打在那个跑着旧代码的进程上，两条断言"失败"其实是假的。

环境变量：`AGENTMAKE_REPLAY=<runId>` 开启重放 · `AGENTMAKE_PORT`(8787) · `AGENTMAKE_DB` · `AGENTMAKE_URL`（harness 用）· `AGENTMAKE_CHILDREN=0` 子进程不带探针 · `AGENTMAKE_RECORD_ALL=1` 不用选、什么都记（以前的被动监视）· `AGENTMAKE=0` 关闭拦截 · `AGENTMAKE_DEBUG=1` 打印安装错误 · `AGENTMAKE_BREAK_TIMEOUT_MS`(600000) 断点最长挂起 · `AGENTMAKE_MAX_HTTP`(5000) 单次运行记录的普通 HTTP 上限 · `AGENTMAKE_NODE_HTTP=0` 不拦 node:http · `AGENTMAKE_BODY_BYTES`(262144) 响应体最多记多少

### Langfuse tracing（可选）

服务端会把每次被观测的 agent run 导出到 Langfuse。导出器默认关闭，只有同时配置
`LANGFUSE_PUBLIC_KEY` 和 `LANGFUSE_SECRET_KEY` 才会启用；可用 `AGENTMAKE_LANGFUSE=0`
显式关闭。使用 Langfuse Cloud 时还应设置正确区域的 `LANGFUSE_BASE_URL`（例如
`https://cloud.langfuse.com` 或 `https://us.cloud.langfuse.com`），并可用
`LANGFUSE_TRACING_ENVIRONMENT=development|staging|production` 区分环境：

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-... \
LANGFUSE_SECRET_KEY=sk-lf-... \
LANGFUSE_BASE_URL=https://cloud.langfuse.com \
LANGFUSE_TRACING_ENVIRONMENT=development \
node src/server/index.ts
```

每次运行对应一个 `agent` 根观测（名称 `agent-run`），LLM 请求对应 `generation`，
其他 HTTP 请求对应 `tool`；generation 会记录模型、可计费 token 用量、输入消息和
assistant 输出。URL 查询参数会被移除，避免 API key 等敏感信息进入 trace。进程收到
`SIGINT`/`SIGTERM` 时会先 flush 并 shutdown exporter，确保短命进程的尾部 trace 不丢失。
