// 两次运行的对比。
//
// 典型问题：「我改了一句 prompt，到底影响了什么？」
//
// 按 LLM 调用的先后顺序对齐（同一个 agent 的两次运行，调用序列结构上一致）。
// 每对给出：请求是否相同（指纹）、响应是否相同、以及第一处差异在哪。
// 第一个「请求变了」的位置就是改动的注入点，它之后的差异都是连锁反应 —— 这个区分很重要，
// 否则用户会把下游的必然变化误读成新问题。

import { messageFullText, toolCallText } from '../shared/tooltext.ts';
import type { MessageIR, ToolCallIR } from '../shared/types.ts';

type Call = {
  call_id: string;
  seq: number;
  model: string | null;
  request_hash: string | null;
  frames: string | null;
  system: string | null;
  messages: string | null;
  response_text: string | null;
  response_tool_calls?: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  duration_ms: number | null;
  replayed: number;
  ok: number;
};

export type PairDiff = {
  index: number;
  a: string | null;
  b: string | null;
  requestSame: boolean;
  responseSame: boolean;
  fn: string | null;
  /** 第一处不同的字段 */
  changedIn: 'system' | 'messages' | 'model' | '—' | '（仅存在于一侧）';
  snippet: { a: string; b: string } | null;
  /** 响应里模型选的工具不一样 —— 只调工具的回答文本为空，不看这个就会误判成「响应相同」 */
  toolCalls?: { a: string; b: string };
  /** 两边被判失败的评分名（任一边非空时才出现） */
  failing?: { a: string[]; b: string[] };
};

type ScoreSummary = { failedCalls: number; runFailures: string[]; byName: Record<string, number> };

/** 评分上下文由调用方从库里查好传进来，compareRuns 本身保持纯函数 */
export type ScoreContext = {
  failingA?: Map<string, string[]>;
  failingB?: Map<string, string[]>;
  summaryA?: ScoreSummary;
  summaryB?: ScoreSummary;
};

export type CompareResult = {
  runA: string;
  runB: string;
  counts: { a: number; b: number; identical: number; requestChanged: number; responseChanged: number };
  /** 第一处请求发生变化的下标 —— 改动的注入点 */
  divergeAt: number | null;
  tokens: { a: number; b: number };
  replayed: { a: number; b: number };
  pairs: PairDiff[];
  /**
   * 「改完到底有没有变好」—— 只看差异回答不了这个问题，要看失败判定的增减。
   * fixed = A 里失败、B 里不再失败；introduced = B 里新冒出来的失败。形如 `#2 rule.truncated`。
   */
  scores?: {
    a: ScoreSummary;
    b: ScoreSummary;
    fixed: string[];
    introduced: string[];
    verdict: 'better' | 'worse' | 'mixed' | 'same';
  };
};

const parse = (s: unknown, d: unknown) => { try { return JSON.parse(String(s)); } catch { return d; } };
const fnOf = (c?: Call) => {
  const f = parse(c?.frames, []) as { fn: string }[];
  return f.length ? f[f.length - 1].fn : null;
};

/** 工具调用的比对键：名字 + 参数。调用 id 每次随机，不参与比较 */
const callsText = (c: Call): string =>
  ((parse(c.response_tool_calls, []) ?? []) as ToolCallIR[]).map(toolCallText).join('; ');

/** 找出第一处不同，给一小段上下文——整段 diff 对 AI 和人都太吵 */
function firstDiff(a: string, b: string): { a: string; b: string } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const from = Math.max(0, i - 40);
  return { a: a.slice(from, i + 80), b: b.slice(from, i + 80) };
}

export function compareRuns(
  runA: string,
  runB: string,
  callsA: Call[],
  callsB: Call[],
  sc: ScoreContext = {},
): CompareResult {
  const n = Math.max(callsA.length, callsB.length);
  const fixed: string[] = [];
  const introduced: string[] = [];
  const failOf = (m: Map<string, string[]> | undefined, c?: Call) => (c && m?.get(c.call_id)) || [];
  const diffFailing = (i: number, fa: string[], fb: string[]) => {
    for (const x of fa) if (!fb.includes(x)) fixed.push(`#${i} ${x}`);
    for (const x of fb) if (!fa.includes(x)) introduced.push(`#${i} ${x}`);
    return fa.length || fb.length ? { failing: { a: fa, b: fb } } : {};
  };
  const pairs: PairDiff[] = [];
  let identical = 0;
  let requestChanged = 0;
  let responseChanged = 0;
  let divergeAt: number | null = null;

  for (let i = 0; i < n; i++) {
    const a = callsA[i];
    const b = callsB[i];

    if (!a || !b) {
      pairs.push({
        index: i,
        a: a?.call_id ?? null,
        b: b?.call_id ?? null,
        requestSame: false,
        responseSame: false,
        fn: fnOf(a ?? b),
        changedIn: '（仅存在于一侧）',
        snippet: null,
        ...diffFailing(i, failOf(sc.failingA, a), failOf(sc.failingB, b)),
      });
      requestChanged++;
      if (divergeAt === null) divergeAt = i;
      continue;
    }

    const requestSame = !!a.request_hash && a.request_hash === b.request_hash;
    const ta = callsText(a);
    const tb = callsText(b);
    const responseSame = (a.response_text ?? '') === (b.response_text ?? '') && ta === tb;

    let changedIn: PairDiff['changedIn'] = '—';
    let snippet: PairDiff['snippet'] = null;
    if (!requestSame) {
      if ((a.model ?? '') !== (b.model ?? '')) changedIn = 'model';
      else if ((a.system ?? '') !== (b.system ?? '')) {
        changedIn = 'system';
        snippet = firstDiff(a.system ?? '', b.system ?? '');
      } else {
        changedIn = 'messages';
        // 用完整文本比：content 里工具块只是占位符，工具结果变了在那里看不出来
        const ma = (parse(a.messages, []) as MessageIR[]).map(messageFullText).join('\n');
        const mb = (parse(b.messages, []) as MessageIR[]).map(messageFullText).join('\n');
        snippet = firstDiff(ma, mb);
      }
      requestChanged++;
      if (divergeAt === null) divergeAt = i;
    }
    if (!responseSame) responseChanged++;
    if (requestSame && responseSame) identical++;

    pairs.push({
      index: i,
      a: a.call_id,
      b: b.call_id,
      requestSame,
      responseSame,
      fn: fnOf(a),
      changedIn,
      snippet,
      ...(ta !== tb ? { toolCalls: { a: ta || '（没调工具）', b: tb || '（没调工具）' } } : {}),
      ...diffFailing(i, failOf(sc.failingA, a), failOf(sc.failingB, b)),
    });
  }

  // 运行级评分（没挂在某次调用上的）按名字比
  const ra = sc.summaryA?.runFailures ?? [];
  const rb = sc.summaryB?.runFailures ?? [];
  for (const x of ra) if (!rb.includes(x)) fixed.push(`运行 ${x}`);
  for (const x of rb) if (!ra.includes(x)) introduced.push(`运行 ${x}`);

  const sum = (cs: Call[], k: 'input_tokens' | 'output_tokens') =>
    cs.reduce((s, c) => s + (c[k] ?? 0), 0);

  return {
    runA,
    runB,
    counts: { a: callsA.length, b: callsB.length, identical, requestChanged, responseChanged },
    divergeAt,
    tokens: { a: sum(callsA, 'input_tokens') + sum(callsA, 'output_tokens'),
              b: sum(callsB, 'input_tokens') + sum(callsB, 'output_tokens') },
    replayed: { a: callsA.filter((c) => c.replayed).length, b: callsB.filter((c) => c.replayed).length },
    pairs,
    ...(sc.summaryA && sc.summaryB
      ? {
          scores: {
            a: sc.summaryA,
            b: sc.summaryB,
            fixed,
            introduced,
            verdict: fixed.length && introduced.length ? 'mixed'
              : fixed.length ? 'better'
              : introduced.length ? 'worse'
              : 'same',
          },
        }
      : {}),
  };
}
