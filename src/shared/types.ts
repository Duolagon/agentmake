// 归一化中间表示（IR）—— harness 与 server 共用。
//
// 存在的理由：三家协议（Gemini / OpenAI 兼容 / Anthropic）的请求与响应形状差别很大，
// UI 和 MCP 不应该认识任何一家的原生格式。所有下游只认这里定义的形状。
//
// ⚠️ 只用可擦除的 TS 语法（Node 原生类型剥离不支持 enum / namespace / 参数属性）。

import type { Frame } from './stack.ts';

export type { Frame };

/** openai_responses = OpenAI 的 Responses API（/v1/responses）：input / instructions / output 那一套，和 chat completions 不是一个形状 */
export type ProviderKind = 'gemini' | 'openai' | 'openai_responses' | 'anthropic' | 'unknown';

export type MessageIR = {
  /** 统一为 user / assistant / system / tool —— Gemini 的 `model` 在此归一为 assistant */
  role: string;
  /** 纯文本视图。工具块在这里只留 «toolUse x» 这类占位，结构化内容在下面两个字段 */
  content: string;
  /** 原始角色名，用于 denormalize 时精确还原 */
  rawRole?: string;
  /** 这条（助手）消息里模型发起的工具调用。没有就不出现这个键 —— 不影响老数据的指纹 */
  toolCalls?: ToolCallIR[];
  /** 这条消息回给模型的工具结果 */
  toolResults?: ToolResultIR[];
};

/**
 * 模型发起的一次工具调用。
 *
 * 对 agent 来说「调了哪个工具、传了什么参数」是最关键的决策，只看文本等于看不见它。
 */
export type ToolCallIR = {
  /** 协议给的调用 id（OpenAI call_… / Anthropic toolu_…）；Gemini 老版本没有 */
  id: string | null;
  name: string;
  /** 尽量解析成对象。OpenAI 给的是 JSON 字符串，解析失败时保留原串 */
  args: unknown;
  /** 参数是字符串但不是合法 JSON —— 模型写坏了参数，下游必然出错 */
  argsInvalid?: boolean;
};

export type ToolResultIR = {
  /** 对应的 ToolCallIR.id */
  callId: string | null;
  /** 只有 Gemini 和 OpenAI 的旧 function 角色会带工具名 */
  name: string | null;
  content: string;
  isError?: boolean;
};

export type ToolDefIR = {
  name: string;
  description?: string;
  schema?: unknown;
};

export type LLMRequestIR = {
  provider: ProviderKind;
  model: string;
  system: string | null;
  messages: MessageIR[];
  tools: ToolDefIR[];
  /** temperature / maxTokens 等，已按各家字段名归一 */
  params: Record<string, unknown>;
  /** 原始请求体。denormalize 时做保守合并的基准——只回写用户实际改过的路径 */
  raw: unknown;
};

export type UsageIR = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens?: number | null;
};

export type LLMResponseIR = {
  text: string;
  /** 只调工具、不说话的回答 text 为空 —— 这时模型的决策全在这里 */
  toolCalls: ToolCallIR[];
  finishReason: string | null;
  usage: UsageIR;
  raw: unknown;
};

// ── 事件协议 ───────────────────────────────────────────────

export type EventBase = {
  runId: string;
  seq: number;
  ts: number;
};

/**
 * 一次运行。默认一个进程就是一次运行；常驻服务里每个入站请求是一次「请求级运行」，
 * 挂在进程运行下面（parentRunId）。
 *
 * 为什么要切：news 这种 HTTP 服务一个进程跑一整天，所有请求混成一次运行的话，
 * 流程图、对比、重放全都失去意义 —— 它们的单位都应该是「一次请求」。
 */
export type RunStarted = EventBase & {
  type: 'run.started';
  cwd: string;
  argv: string[];
  pid: number;
  /** process = 进程级（默认）· request = 入站请求级 */
  kind?: 'process' | 'request';
  /** 请求级运行所属的进程运行 */
  parentRunId?: string;
  /** 运行组。AGENTMAKE_GROUP 指定，或缺省为进程运行自己 —— 把一批运行归到一起看 */
  groupId?: string;
  /** 触发这次运行的入站请求，如 `POST /api/dispatch`（不带 query，避免把参数里的密钥带进来） */
  trigger?: string;
  /** 这次运行以谁为重放基线（AGENTMAKE_REPLAY 的值：一个运行或一个运行组） */
  replayOf?: string;
};

export type RunEnded = EventBase & {
  type: 'run.ended';
  exitCode: number | null;
  /** 请求级运行结束时回给客户端的状态码 */
  httpStatus?: number;
  /** 请求级运行的入站请求本身 —— 批量回归时原样重发给改好的服务 */
  request?: InboundRequest;
};

export type InboundRequest = {
  method: string;
  /** 路径 + query（重发要原样带上；页面上展示用的 trigger 是去掉 query 的） */
  url: string;
  contentType: string | null;
  body: string;
  /** 请求体超过上限，只记了前一段 —— 这种请求不能拿来重发 */
  truncated: boolean;
};

/** 常驻服务开始监听 —— 批量回归要知道往哪个端口重发 */
export type RunListening = EventBase & {
  type: 'run.listening';
  port: number;
  host: string | null;
};

export type LLMBefore = EventBase & {
  type: 'llm.before';
  callId: string;
  url: string;
  request: LLMRequestIR;
  /** 调用路径（最外层 → 最内层），执行图就是从这里推导出来的 */
  frames: Frame[];
};

export type LLMAfter = EventBase & {
  type: 'llm.after';
  callId: string;
  ok: boolean;
  status: number;
  durationMs: number;
  response: LLMResponseIR | null;
  error: string | null;
  /** 流式响应暂不解析响应体，只做标记 */
  streaming: boolean;
  /** 断点上伪造的响应，模型并没有被真的调用 */
  faked?: boolean;
  /** 断点上主动中止 */
  aborted?: boolean;
  /** 响应后断点上改写了模型的回答 */
  replaced?: boolean;
  /** 响应来自重放缓存，模型没有被真的调用（不花钱、不等待） */
  replayed?: boolean;
  /** 实际发出请求的指纹，重放缓存的键 */
  requestHash?: string;
};

/**
 * 非 LLM 的 HTTP 调用（抓取信源、调工具 API…）。
 * 只有 LLM 调用的话执行图会退化成单个节点 —— news 整条流水线只有一处调模型，
 * 真正的结构（7 次并发抓取）全在这些普通请求里。
 */
export type HttpCall = EventBase & {
  type: 'http.call';
  callId: string;
  method: string;
  url: string;
  status: number;
  ok: boolean;
  durationMs: number;
  /** 真正发出请求的时刻。事件本身是**调用结束后**才发的，ts 是结束时间 ——
      瀑布图要的是开始时间，两者差一个 durationMs。 */
  startedAt?: number;
  error: string | null;
  frames: Frame[];
  /** 响应体（有上限）。Python 钩子同步拿得到就直接带上；Node 侧异步读，走 http.body */
  responseBody?: string;
  responseBytes?: number;
};

/**
 * 工具调用的响应体，在 http.call 之后异步补上。
 *
 * 没有它就看不见「数据流」：load_history 返回了 12 条、analyze 的 prompt 里只出现了 5 条 ——
 * 这种 bug 只有把上游的输出和下游的输入摆在一起才看得出来。读 clone 的副本，不碰用户的流。
 */
export type HttpBody = EventBase & {
  type: 'http.body';
  callId: string;
  /** 响应体总字节数（被截断时是读到上限为止的字节数，或 content-length） */
  bytes: number;
  body: string;
  truncated: boolean;
};

/**
 * 断点里改过 prompt 之后**实际发出去**的请求。
 *
 * 没有这条事件时，库里存的是改之前的版本 —— 而这个产品的核心承诺就是
 * 「看到实际发出的完整 prompt」，改完还显示旧的，等于把承诺打折。
 */
export type LLMPatched = EventBase & {
  type: 'llm.patched';
  callId: string;
  url: string;
  request: LLMRequestIR;
};

export type AgentEvent = RunStarted | RunEnded | RunListening | LLMBefore | LLMPatched | LLMAfter | HttpCall | HttpBody;
