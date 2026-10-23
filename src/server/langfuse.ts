// Langfuse 导出器 —— 把被调试 agent 的每次运行镜像到 Langfuse（可选能力）。
//
// 设计要点：
// - 纯可选。没跑过 `npm install`（缺 @langfuse/* 依赖）或没配 LANGFUSE_PUBLIC_KEY /
//   LANGFUSE_SECRET_KEY 时完全无感：相关依赖全部动态 import，失败只记一条日志降级为
//   no-op，调试器照常工作。`AGENTMAKE_LANGFUSE=0` 可显式关闭。
// - 数据流挂在服务端 record() 上，按事件流增量构建 trace：
//     一次运行（runId）= 一个 trace「agent-run」
//       llm.before + llm.after → generation（模型名、prompt、响应、token 用量、耗时、错误）
//       http.call              → tool（method / url / status / 耗时 / 错误）
//   断点伪造 / 重放 / 中止的调用在 metadata 里带 faked / replayed / aborted 标记，
//   不冒充真实调用，方便过滤「模型真被调过几次」。
// - 铁律与 harness 一致：Langfuse 的任何失败都不允许影响调试器本身。

import type {
  AgentEvent,
  HttpCall,
  LLMAfter,
  LLMBefore,
  RunEnded,
  RunStarted,
} from '../shared/types.ts';
// 类型导入在运行时被擦除 —— 保持「没装依赖也能跑」的现状
import type { LangfuseAgent, LangfuseGeneration, LangfuseTool } from '@langfuse/tracing';

const TRACE_NAME = 'agent-run';
const TAG = 'agentmake';
const SOURCE = 'agentmake';
// Stable names act as the API for dashboards/evaluators; keep them low-cardinality.
const LLM_OBS_NAME = 'llm-call';
const HTTP_OBS_NAME = 'http-call';

/** 手写的动态 import 模块形状 —— 只声明我们用到的那几个函数 */
type TracingModule = {
  propagateAttributes(
    attrs: Record<string, unknown>,
    fn: () => unknown,
  ): unknown;
  startObservation(
    name: string,
    attrs: Record<string, unknown>,
    opts?: { asType?: string; startTime?: Date },
  ): unknown;
};

type RunMeta = {
  pid?: number;
  cwd?: string;
  argv?: string[];
  startedAt?: number;
};

type RunState = {
  root: LangfuseAgent | null;
  rootHasInput: boolean;
  /** callId → 还没等到结果的 generation（断点伪造/重放路径也一样先 after 后补） */
  gens: Map<string, LangfuseGeneration>;
  /** callId → model name, retained so a late llm.after still has generation attribution */
  models: Map<string, string>;
  /** callId → 挂起中的 http「before」观测（http 断点开着时会有两个 http.call 事件） */
  http: Map<string, LangfuseTool>;
  meta: RunMeta;
  /** 最近一次成功的模型响应文本 —— 作为 trace 输出 */
  lastOutput: unknown;
  ended: boolean;
};

export class LangfuseTracer {
  #enabled = false;
  #ready: Promise<void> = Promise.resolve();
  #queue: AgentEvent[] = [];
  #tracing: TracingModule | null = null;
  #processor: { forceFlush(): Promise<void> } | null = null;
  #sdk: { shutdown(): Promise<void> } | null = null;
  #runs = new Map<string, RunState>();

  constructor() {
    const explicitlyDisabled = process.env.AGENTMAKE_LANGFUSE === '0';
    const hasKeys = Boolean(
      process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
    );
    if (explicitlyDisabled || !hasKeys) return;
    this.#enabled = true;
    this.#ready = this.#setup();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  async #setup(): Promise<void> {
    try {
      const [{ NodeSDK }, { LangfuseSpanProcessor }] = await Promise.all([
        import('@opentelemetry/sdk-node'),
        import('@langfuse/otel'),
      ]);
      const tracing = (await import('@langfuse/tracing')) as unknown as TracingModule;
      this.#tracing = tracing;
      const processor = new LangfuseSpanProcessor({});
      this.#processor = processor;
      const sdk = new NodeSDK({ spanProcessors: [processor] });
      sdk.start();
      this.#sdk = sdk;
      console.log(
        `agentmake langfuse → ${process.env.LANGFUSE_BASE_URL ?? 'https://cloud.langfuse.com'}（trace 名「${TRACE_NAME}」）`,
      );
    } catch (err) {
      // 缺依赖 / 初始化失败：降级为 no-op，调试器不受影响
      this.#enabled = false;
      console.warn(
        `agentmake: langfuse 导出未启用（${err instanceof Error ? err.message : String(err)}）`,
      );
    }
  }

  /** 事件入口 —— 由服务端 record() 调用。Langfuse 未启用时是 O(1) 空操作 */
  onEvent(ev: AgentEvent): void {
    if (!this.#enabled) return;
    this.#queue.push(ev);
    // 初始化是异步的（动态 import），期间的事件先排队，就绪后按序补处理
    void this.#ready.then(() => this.#drain());
  }

  /** 进程退出前调用，把积压的 span 真正发出去 */
  async shutdown(): Promise<void> {
    await this.#ready.catch(() => {});
    if (this.#processor) {
      try {
        await this.#processor.forceFlush();
      } catch {
        /* ignore */
      }
    }
    if (this.#sdk) {
      try {
        await this.#sdk.shutdown();
      } catch {
        /* ignore */
      }
    }
  }

  #drain(): void {
    if (!this.#enabled) return;
    const q = this.#queue;
    this.#queue = [];
    for (const ev of q) {
      try {
        if (process.env.AGENTMAKE_LANGFUSE_DEBUG) {
          console.log(`[am-lf] handle ${ev.type} run=${ev.runId} seq=${ev.seq}`);
        }
        this.#handle(ev);
      } catch (err) {
        console.warn(
          `agentmake: langfuse 上报跳过（${err instanceof Error ? err.message : String(err)}）`,
        );
      }
    }
  }

  #handle(ev: AgentEvent): void {
    switch (ev.type) {
      case 'run.started':
        this.#runStarted(ev);
        break;
      case 'run.ended':
        this.#runEnded(ev);
        break;
      case 'llm.before':
        this.#llmBefore(ev);
        break;
      case 'llm.after':
        this.#llmAfter(ev);
        break;
      case 'http.call':
        this.#httpCall(ev);
        break;
    }
  }

  #state(runId: string): RunState {
    let st = this.#runs.get(runId);
    if (!st) {
      st = {
        root: null,
        rootHasInput: false,
        gens: new Map(),
        models: new Map(),
        http: new Map(),
        meta: {},
        lastOutput: undefined,
        ended: false,
      };
      this.#runs.set(runId, st);
    }
    return st;
  }

  /** 建 run 的根 span（一次运行一个 trace）。run.started 没收到时（附着模式）也补建 */
  #ensureRoot(runId: string, ts: number): RunState | null {
    const st = this.#state(runId);
    if (st.root) return st;
    const t = this.#tracing;
    if (!t) return null;

    const meta = st.meta;
    const traceMeta: Record<string, string> = { runId, source: SOURCE };
    if (meta.pid != null) traceMeta.pid = String(meta.pid);
    if (meta.cwd) traceMeta.cwd = meta.cwd;
    if (meta.argv?.length) traceMeta.argv = JSON.stringify(meta.argv).slice(0, 200);

    let root: LangfuseAgent | null = null;
    t.propagateAttributes(
      {
        traceName: TRACE_NAME,
        tags: [TAG],
        environment:
          process.env.LANGFUSE_TRACING_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
        metadata: traceMeta,
      },
      () => {
        root = t.startObservation(
          TRACE_NAME,
          { metadata: { ...traceMeta } },
          { asType: 'agent', startTime: new Date(ts) },
        ) as LangfuseAgent;
      },
    );
    st.root = root;
    return st;
  }

  #runStarted(ev: RunStarted): void {
    const st = this.#state(ev.runId);
    st.meta = { pid: ev.pid, cwd: ev.cwd, argv: ev.argv, startedAt: ev.ts };
    this.#ensureRoot(ev.runId, ev.ts);
  }

  #llmBefore(ev: LLMBefore): void {
    const st = this.#ensureRoot(ev.runId, ev.ts);
    const t = this.#tracing;
    if (!st || !st.root || !t) return;

    const input = messagesInput(ev.request.system, ev.request.messages);
    const metadata: Record<string, unknown> = {
      callId: ev.callId,
      url: redactUrl(ev.url),
      provider: ev.request.provider,
      frames: framesMeta(ev.frames),
    };
    const modelParameters = primitiveParams(ev.request.params);
    if (Object.keys(modelParameters).length > 0) metadata.params = modelParameters;
    if (ev.request.tools.length > 0) {
      metadata.tools = ev.request.tools.map((x) => x.name);
    }

    let gen: LangfuseGeneration | null = null;
    // Create children from the root observation so Langfuse preserves the
    // agent → generation hierarchy even when events arrive asynchronously.
    gen = st.root.startObservation(
      LLM_OBS_NAME,
      { model: ev.request.model, input, modelParameters, metadata },
      { asType: 'generation', startTime: new Date(ev.ts) },
    ) as LangfuseGeneration;
    if (!gen) return;

    st.gens.set(ev.callId, gen);
    st.models.set(ev.callId, ev.request.model);
    // trace 输入取第一次 LLM 调用的 prompt —— 让「这次运行到底让模型干了什么」一目了然
    if (!st.rootHasInput) {
      st.rootHasInput = true;
      st.root.update({ input });
    }
  }

  #llmAfter(ev: LLMAfter): void {
    const st = this.#runs.get(ev.runId);
    if (!st || st.ended) return;

    // 兜底：http 断点「中止」路径的怪癖会让 http 调用也发出 llm.after 事件（见 intercept.ts）。
    // 这时把它当作 http 调用的失败完成处理，别在 trace 里长出幽灵 generation。
    if (st.http.has(ev.callId)) {
      const tool = st.http.get(ev.callId)!;
      const attrs: Record<string, unknown> = {
        output: { status: ev.status },
        level: 'ERROR',
        statusMessage: ev.error ?? `HTTP ${ev.status}`,
        metadata: { status: ev.status, ok: ev.ok, durationMs: ev.durationMs },
      };
      if (ev.error) (attrs.metadata as Record<string, unknown>).error = ev.error;
      tool.update(attrs);
      tool.end(new Date(ev.ts));
      st.http.delete(ev.callId);
      return;
    }

    let gen = st.gens.get(ev.callId);
    if (!gen) {
      // llm.before 丢了（进程被 kill 等极端情况）——用已知信息补一个，别让调用静默消失
      const t = this.#tracing;
      if (!t || !st.root) return;
      let created: LangfuseGeneration | null = null;
      created = st.root.startObservation(
        LLM_OBS_NAME,
        { model: st.models.get(ev.callId) ?? 'unknown', metadata: { callId: ev.callId } },
        { asType: 'generation', startTime: new Date(ev.ts - ev.durationMs) },
      ) as LangfuseGeneration;
      gen = created;
      if (!gen) return;
    }

    const attrs: Record<string, unknown> = {};
    if (ev.response?.text) attrs.output = { role: 'assistant', content: ev.response.text };
    const usage: Record<string, number> = {};
    if (ev.response?.usage.inputTokens != null) usage.input = ev.response.usage.inputTokens;
    if (ev.response?.usage.outputTokens != null) usage.output = ev.response.usage.outputTokens;
    if (ev.response?.usage.cacheReadTokens != null) {
      usage.cache_read_input_tokens = ev.response.usage.cacheReadTokens;
    }
    if (Object.keys(usage).length > 0) attrs.usageDetails = usage;
    if (!ev.ok || ev.error) {
      attrs.level = 'ERROR';
      attrs.statusMessage = ev.error ?? `HTTP ${ev.status}`;
    }

    const metadata: Record<string, unknown> = {
      status: ev.status,
      ok: ev.ok,
      durationMs: ev.durationMs,
      finishReason: ev.response?.finishReason ?? null,
      streaming: ev.streaming,
    };
    if (ev.faked) metadata.faked = true;
    if (ev.aborted) metadata.aborted = true;
    if (ev.replaced) metadata.replaced = true;
    if (ev.replayed) metadata.replayed = true;
    if (ev.requestHash) metadata.requestHash = ev.requestHash;
    if (ev.error) metadata.error = ev.error;
    attrs.metadata = metadata;

    gen.update(attrs);
    gen.end(new Date(ev.ts));
    if (ev.ok && ev.response?.text) {
      st.lastOutput = { role: 'assistant', content: ev.response.text };
    }
  }

  #httpCall(ev: HttpCall): void {
    const st = this.#ensureRoot(ev.runId, ev.ts);
    const t = this.#tracing;
    if (!st || !st.root || !t) return;

    // http 断点开着时同一个 callId 会来两个事件：before（status 0 / duration 0）与真实结果。
    // 前者先建观测挂起，后者补结果后收尾；只来一个的就是普通调用，直接建完即结束。
    const isPendingBefore = ev.status === 0 && ev.durationMs === 0 && !ev.error;
    const existing = st.http.get(ev.callId);

    const completionAttrs = (): Record<string, unknown> => {
      const attrs: Record<string, unknown> = {
        output: { status: ev.status },
        metadata: {
          status: ev.status,
          ok: ev.ok,
          durationMs: ev.durationMs,
        },
      };
      if (!ev.ok || ev.error) {
        attrs.level = 'ERROR';
        attrs.statusMessage = ev.error ?? `HTTP ${ev.status}`;
      }
      if (ev.error) (attrs.metadata as Record<string, unknown>).error = ev.error;
      return attrs;
    };

    if (existing) {
      existing.update(completionAttrs());
      existing.end(new Date(ev.ts));
      st.http.delete(ev.callId);
      return;
    }

    const metadata: Record<string, unknown> = {
      callId: ev.callId,
      method: ev.method,
      url: redactUrl(ev.url),
      frames: framesMeta(ev.frames),
    };
    let tool: LangfuseTool | null = null;
    tool = st.root.startObservation(
      HTTP_OBS_NAME,
      { input: { method: ev.method, url: redactUrl(ev.url) }, metadata },
      {
        asType: 'tool',
        startTime: new Date(isPendingBefore ? ev.ts : ev.ts - ev.durationMs),
      },
    ) as LangfuseTool;
    if (!tool) return;

    if (isPendingBefore) {
      st.http.set(ev.callId, tool);
    } else {
      tool.update(completionAttrs());
      tool.end(new Date(ev.ts));
    }
  }

  #runEnded(ev: RunEnded): void {
    const st = this.#runs.get(ev.runId);
    if (!st || !st.root || st.ended) return;
    st.ended = true;

    const metadata: Record<string, unknown> = {};
    if (ev.exitCode != null) metadata.exitCode = ev.exitCode;
    const output = st.lastOutput ?? { exitCode: ev.exitCode };
    st.root.update({ output, metadata });
    st.root.end(new Date(ev.ts));

    // 没等到结果的 generation / http before 观测保持未结束 —— OTel 只在 end 时导出，
    // 它们自然不会被导出，比伪装成「已完成」更诚实（调用确实没有完成）。
    st.gens.clear();
    st.models.clear();
    st.http.clear();
    this.#runs.delete(ev.runId);
  }
}

/** OpenAI 风格消息数组 —— Langfuse UI 会渲染成可读的对话，而不是 JSON 坨 */
function messagesInput(system: string | null, messages: { role: string; content: string }[]): unknown {
  const out: { role: string; content: string }[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

/** 调用路径（最外层 → 最内层）—— 与执行图节点同构，方便对照 */
function framesMeta(frames: { file: string; fn: string }[]): string[] {
  return (frames ?? []).map((f) => (f.fn === '<top>' ? f.file : `${f.file}#${f.fn}`));
}

/** Keep model parameters useful for Langfuse cost/debug views without serializing secrets or objects. */
function primitiveParams(params: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
    else if (typeof value === 'boolean') out[key] = value ? 1 : 0;
  }
  return out;
}

/** Query strings often contain API keys/tokens; only retain the endpoint path in traces. */
function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?', 1)[0];
  }
}

/** 服务端单例：src/server/index.ts 在 record() 里调 onEvent */
export const langfuseTracer = new LangfuseTracer();
