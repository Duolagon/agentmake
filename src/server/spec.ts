// Agent 规格（spec）与「意图 vs 实际」对账。
//
// flow.ts 回答「它实际怎么跑的」。这里回答另外半个问题：**你以为它怎么跑**，
// 以及两者差在哪。
//
// 为什么这半个问题值得单独做：agent 的 bug 大多不是崩溃，是「跑通了但不是你想的那样」——
// 那条 fallback 分支从来没走到、循环偷偷跑了 12 轮、重试悄悄多打了 3 次模型。
// 这些在日志里都是「成功」，只有拿你的意图去比才看得出来。
//
// spec 同时是给 AI 的规格：AI 拿到 [你画的意图] + [当前实际 flow] + [两者的差]，
// 比拿一段自然语言描述精确得多。

import type { Flow, FlowStep } from './flow.ts';

export type SpecStep = {
  /** 稳定 id，spec 内唯一。绑定关系挂在它上面，所以不能因为改名就变 */
  id: string;
  kind: 'llm' | 'tool' | 'loop';
  /** 人看的名字：「评审」「抓资料」 */
  label: string;
  /** 这一步要做什么 —— 给 AI 的规格正文 */
  intent?: string;
  /** prompt 要点或草稿（kind=llm） */
  prompt?: string;
  model?: string;
  /** 属于哪个循环步骤（kind=loop 的那个 step 的 id） */
  parentId?: string | null;
  /** 前置步骤 id —— 连线。空数组表示没有前置约束 */
  after?: string[];
  /** 允许某些轮不跑（它本来就在 if 里）。不标的话，实际是分支就会被报出来 */
  optional?: boolean;
  /** kind=loop：你预期最多跑几轮 */
  maxIterations?: number | null;
  /** 允许并发发生（同一排）—— 不标的话并发会被当成「顺序和你画的不一致」 */
  parallel?: boolean;
  /**
   * 绑定到实际流程里的哪个步骤 id。
   *
   * 为什么要显式绑定而不是全靠名字猜：spec 里写的是「评审」，实际步骤 id 是
   * `/abs/path/agent.mjs#review:12`。靠名字模糊匹配在中英混排、同名函数、
   * 改名重构面前都会错，而对账一旦错配，输出的差异全是噪音 —— 还不如没有。
   * 所以：名字能对上就自动绑，对不上就让用户点一次，绑定存进 spec 长期有效。
   */
  bind?: string | null;
};

export type Spec = {
  name: string;
  /** 一句话说明这个 agent 干什么 */
  goal?: string;
  steps: SpecStep[];
  updatedAt?: number;
};

export type Finding = {
  kind:
    | 'missing'        // 画了但这次没跑到
    | 'unexpected'     // 跑了但没画
    | 'order'          // 实际顺序与连线冲突
    | 'loop_overrun'   // 循环跑得比预期多
    | 'loop_short'     // 循环一轮没跑
    | 'branch'         // 没标 optional，实际却不是每轮都跑
    | 'failed'         // 实际有失败
    | 'unbound';       // 名字对不上，需要你点一次绑定
  /** 严重程度：blocker 是「你的心智模型和现实不符」，info 是提示 */
  level: 'blocker' | 'warn' | 'info';
  specStepId?: string;
  flowStepId?: string;
  message: string;
  /** unbound 时给出候选，用户点一下就绑上 */
  candidates?: { id: string; label: string }[];
};

export type Reconciliation = {
  runId: string | null;
  /** specStepId → flowStepId */
  matches: Record<string, string>;
  findings: Finding[];
  coverage: { matched: number; total: number; unexpected: number };
};

/** 名字归一化：去空白、去标点、小写。只用于**自动**绑定，绑不上就交给用户 */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\s_\-·:：()（）[\]]/g, '');
}

export function emptySpec(name = 'agent'): Spec {
  return { name, goal: '', steps: [], updatedAt: Date.now() };
}

export function reconcile(spec: Spec, flow: Flow): Reconciliation {
  const findings: Finding[] = [];
  const matches: Record<string, string> = {};
  const byId = new Map(flow.steps.map((s) => [s.id, s]));
  const usedFlow = new Set<string>();

  const specSteps = spec.steps ?? [];
  const loopSteps = specSteps.filter((s) => s.kind === 'loop');
  const actionSteps = specSteps.filter((s) => s.kind !== 'loop');

  // ── 1. 绑定：显式优先，名字次之 ──
  for (const ss of actionSteps) {
    if (ss.bind && byId.has(ss.bind)) {
      matches[ss.id] = ss.bind;
      usedFlow.add(ss.bind);
    }
  }
  for (const ss of actionSteps) {
    if (matches[ss.id]) continue;
    const target = norm(ss.label);
    const hits = flow.steps.filter((f) => !usedFlow.has(f.id) && norm(f.label) === target);
    if (hits.length === 1) {
      matches[ss.id] = hits[0].id;
      usedFlow.add(hits[0].id);
    }
  }

  // ── 2. 画了但没跑到 ──
  for (const ss of actionSteps) {
    if (matches[ss.id]) continue;
    // 候选要求同类型：spec 里的「发布」是工具步骤，不该拿一个没绑的 LLM 步骤
    // 去当它的候选 —— 那不是「名字对不上」，那是真的没实现。
    const free = flow.steps.filter((f) => !usedFlow.has(f.id) && f.kind === ss.kind);
    if (free.length) {
      // 有同类型且没绑上的实际步骤在 —— 更可能是名字对不上，而不是真的没跑
      findings.push({
        kind: 'unbound',
        level: 'warn',
        specStepId: ss.id,
        message: `「${ss.label}」没自动对上实际步骤，点一下绑定即可`,
        candidates: free.map((f) => ({ id: f.id, label: f.label })),
      });
    } else {
      findings.push({
        kind: 'missing',
        level: 'blocker',
        specStepId: ss.id,
        message: `「${ss.label}」这次一次都没跑到 —— 死代码，或者进它的条件永远不成立`,
      });
    }
  }

  // ── 3. 跑了但没画 ──
  //
  // 规格是空的时候一条都不报。「你还没写规格」和「你写了规格但漏了这一步」是
  // 两件完全不同的事 —— 前者报出来的话，用户第一次打开页面就会看到每个步骤都被
  // 标成「规格外」，像是产品坏了。
  const hasSpec = specSteps.length > 0;
  for (const fs of hasSpec ? flow.steps : []) {
    if (usedFlow.has(fs.id)) continue;
    findings.push({
      kind: 'unexpected',
      level: 'warn',
      flowStepId: fs.id,
      message:
        `实际跑了「${fs.label}」${fs.file ? `（${fs.file.split('/').pop()}:${fs.line}）` : ''}` +
        `，但规格里没有 —— 藏着的重试？fallback？×${fs.calls}`,
    });
  }

  // ── 4. 顺序 ──
  const orderOf = (specId: string): number | null => {
    const f = byId.get(matches[specId] ?? '');
    return f ? f.order : null;
  };
  for (const ss of actionSteps) {
    const mine = orderOf(ss.id);
    if (mine == null) continue;
    for (const beforeId of ss.after ?? []) {
      const theirs = orderOf(beforeId);
      if (theirs == null) continue;
      if (theirs > mine) {
        const before = specSteps.find((x) => x.id === beforeId);
        findings.push({
          kind: 'order',
          level: 'blocker',
          specStepId: ss.id,
          flowStepId: matches[ss.id],
          message: `你画的是「${before?.label}」→「${ss.label}」，实际反过来了`,
        });
      }
    }
  }

  // ── 5. 循环轮数 ──
  for (const ls of loopSteps) {
    const loop = ls.bind
      ? flow.loops.find((l) => l.id === ls.bind)
      : flow.loops.length === 1
        ? flow.loops[0]
        : undefined;
    if (!loop) {
      findings.push({
        kind: 'missing',
        level: flow.loops.length ? 'warn' : 'blocker',
        specStepId: ls.id,
        message: flow.loops.length
          ? `循环「${ls.label}」没绑到实际循环（实际有 ${flow.loops.length} 个）`
          : `循环「${ls.label}」这次没跑起来 —— 一轮都没进`,
        candidates: flow.loops.map((l) => ({ id: l.id, label: l.label })),
      });
      continue;
    }
    matches[ls.id] = loop.id;

    const max = ls.maxIterations;
    if (max != null && loop.iterations > max) {
      findings.push({
        kind: 'loop_overrun',
        level: 'blocker',
        specStepId: ls.id,
        flowStepId: loop.id,
        message: `你预期最多 ${max} 轮，实际跑了 ${loop.iterations} 轮（退出原因：${loop.exitReason ?? '还在跑'}）`,
      });
    }
    if (loop.iterations === 0) {
      findings.push({
        kind: 'loop_short',
        level: 'warn',
        specStepId: ls.id,
        flowStepId: loop.id,
        message: `循环「${ls.label}」一轮都没跑`,
      });
    }
  }

  // ── 6. 分支覆盖 / 失败 ──
  for (const ss of actionSteps) {
    const f = byId.get(matches[ss.id] ?? '');
    if (!f) continue;
    if (f.conditional && !ss.optional) {
      findings.push({
        kind: 'branch',
        level: 'warn',
        specStepId: ss.id,
        flowStepId: f.id,
        message:
          `「${ss.label}」你按每轮都跑来画的，实际只在 ${f.iterations.length} 轮里跑过 —— ` +
          '它在 if 里。确实该是分支就把它标成「可选」',
      });
    }
    if (f.errors) {
      findings.push({
        kind: 'failed',
        level: 'blocker',
        specStepId: ss.id,
        flowStepId: f.id,
        message: `「${ss.label}」有 ${f.errors} 次失败`,
      });
    }
  }

  // 没写 spec 时也要有输出：把实际跑到的东西如实列出来，用户点「按实际生成规格」就有起点
  return {
    runId: flow.runId,
    matches,
    findings: findings.sort((a, b) => LEVEL[a.level] - LEVEL[b.level]),
    coverage: {
      matched: Object.keys(matches).length,
      total: specSteps.length,
      unexpected: hasSpec ? flow.steps.filter((f) => !usedFlow.has(f.id)).length : 0,
    },
  };
}

const LEVEL = { blocker: 0, warn: 1, info: 2 };

/**
 * 从一次实际运行反推出一份 spec 草稿。
 *
 * 让用户从零画一张图门槛太高 —— 先跑一次，把实际结构变成起点，再在上面改意图、
 * 加还没实现的步骤。这也是 spec 和 flow 用同一套结构的好处。
 */
export function specFromFlow(flow: Flow, name = 'agent'): Spec {
  const steps: SpecStep[] = [];

  for (const l of flow.loops) {
    steps.push({
      id: `loop_${slug(l.label)}`,
      kind: 'loop',
      label: l.label,
      maxIterations: l.iterations || null,
      bind: l.id,
      intent: '',
    });
  }

  const ordered = [...flow.steps].sort((a, b) => a.order - b.order);
  let prev: string | null = null;
  for (const f of ordered) {
    const id = `step_${slug(f.label)}_${f.order}`;
    const parent = f.loopId ? steps.find((s) => s.bind === f.loopId)?.id ?? null : null;
    steps.push({
      id,
      kind: f.kind,
      label: f.label,
      intent: '',
      prompt: f.kind === 'llm' ? (f.preview?.in ?? '') : '',
      model: f.model ?? undefined,
      parentId: parent,
      after: prev ? [prev] : [],
      optional: f.conditional || undefined,
      parallel: f.concurrency > 1 || undefined,
      bind: f.id,
    });
    prev = id;
  }

  return { name, goal: '', steps, updatedAt: Date.now() };
}

function slug(s: string): string {
  return s.replace(/[^\w一-龥]+/g, '_').slice(0, 24) || 'x';
}

/** 给 AI 看的紧凑文本 —— MCP 的 token 预算不允许直接倾倒 JSON */
export function specToText(spec: Spec, flowStepById?: Map<string, FlowStep>): string {
  const out = [`规格「${spec.name}」`, spec.goal ? `目标：${spec.goal}` : '', ''];
  for (const s of spec.steps) {
    const tags = [
      s.kind === 'loop' ? `循环${s.maxIterations ? `（最多 ${s.maxIterations} 轮）` : ''}` : s.kind === 'llm' ? 'LLM' : '工具',
      s.parentId ? `在 ${s.parentId} 内` : '',
      s.optional ? '可选（分支）' : '',
      s.parallel ? '可并发' : '',
      s.after?.length ? `在 ${s.after.join(',')} 之后` : '',
      s.bind ? `已绑定 → ${flowStepById?.get(s.bind)?.label ?? s.bind}` : '未绑定',
    ].filter(Boolean);
    out.push(`[${s.id}] ${s.label}  ${tags.join(' · ')}`);
    if (s.intent) out.push(`  意图：${s.intent}`);
    if (s.prompt) out.push(`  prompt：${s.prompt.slice(0, 200)}${s.prompt.length > 200 ? '…' : ''}`);
    if (s.model) out.push(`  模型：${s.model}`);
  }
  return out.join('\n');
}
