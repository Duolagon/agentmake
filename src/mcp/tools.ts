// 暴露给 AI 编程助手的工具集。
//
// 存在的理由：AI 改 agent 时是瞎的 —— 它只能读代码猜运行时行为，而 agent 的 bug
// 大多藏在「实际发出去的 prompt 到底长什么样」里（模板拼接 + 列表截断 + 变量展开
// 之后的最终形态，读代码推不出来）。给它一个 get_call，等于从盲改变成看着仪表盘改。
//
// ⚠️ Token 预算是硬约束：一次长 run 的完整 trace 可能十万 token 级，直接倾倒会撑爆
// AI 的上下文。所以 —— 摘要优先、按需钻取、大文本一律可截断、**不提供 get_full_trace**。

import { toolCallText, toolResultText } from '../shared/tooltext.ts';
import { RULE_LABELS } from '../server/rules.ts';

const BASE = (process.env.AGENTMAKE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, any>) => Promise<string>;
};

// ── HTTP 辅助 ──────────────────────────────────────────────

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    signal: AbortSignal.timeout(20_000),
  }).catch((e) => {
    throw new Error(
      `连不上 AgentMake 调试器（${BASE}）。先启动它：node src/server/index.ts\n原始错误：${e?.message ?? e}`,
    );
  });
  if (!res.ok) {
    // 服务端的 400 带着能看懂的原因（比如「没有缺省基线」），别吞成一个状态码
    const why = await res.json().then((b: any) => b?.error).catch(() => null);
    throw new Error(why ? String(why) : `${path} → HTTP ${res.status}`);
  }
  return res.json();
}

const post = (path: string, body: unknown) =>
  api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// ── 格式化 ─────────────────────────────────────────────────

const CLIP_NOTE = 48; // 截断提示本身的大致长度

function clip(s: unknown, max: number): string {
  const t = String(s ?? '');
  // 只有真能省下 token 才截断 —— 否则「已截断」提示比省下的还长，纯属倒贴
  if (t.length <= max + CLIP_NOTE) return t;
  return `${t.slice(0, max)}\n…（已截断，共 ${t.length} 字符；要看全文请调大 maxChars）`;
}

const time = (ts: number) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
const tok = (n: unknown) => (n == null ? '—' : String(n));
const parse = (s: unknown, d: unknown) => { try { return JSON.parse(String(s)); } catch { return d; } };

/** 评分的一行形式：`✗ 被截断 [rule] finish_reason=length…` */
function scoreLine(sc: any, max = 300): string {
  const mark = sc.passed === 1 ? '✓' : sc.passed === 0 ? '✗' : '·';
  const name = RULE_LABELS[sc.name] ? `${RULE_LABELS[sc.name]}（${sc.name}）` : sc.name;
  const extra = [sc.value != null ? `值 ${sc.value}` : '', sc.label ? `标签 ${sc.label}` : ''].filter(Boolean).join(' ');
  return `${mark} ${name} [${sc.source}]${extra ? ' ' + extra : ''}${sc.comment ? ` —— ${clip(sc.comment, max)}` : ''}`;
}

/** 运行的一行形式。请求级运行带上触发它的请求，重放出来的带上基线 */
function runLine(r: any, indent = ''): string {
  const what = r.kind === 'request'
    ? `${r.trigger ?? '请求'}${r.http_status ? ` → ${r.http_status}` : ''}`
    : `${r.cwd ?? '?'}${r.child_runs ? `  （${r.child_runs} 个请求）` : ''}`;
  return `${indent}${r.run_id}  ${time(r.started_at)}  ${what}  ` +
    `${r.call_count} 次调用  ${tok(r.input_tokens)}↑${tok(r.output_tokens)}↓ tok` +
    (r.failing ? `  ✗ ${r.failing} 处判定失败` : '') +
    (r.replay_of ? `  «重放自 ${r.replay_of}»` : '') +
    (r.group_id && r.group_id !== r.run_id && r.group_id !== r.parent_run_id ? `  组 ${r.group_id}` : '') +
    (r.ended_at ? '' : '  «仍在运行»');
}

function callLine(c: any): string {
  const head = c.kind === 'http' ? `${c.method || 'GET'} ${c.url}` : `${c.provider}/${c.model || '—'}`;
  const stat = c.ok ? `${c.duration_ms}ms` : `失败 ${c.status || ''} ${c.error ? String(c.error).slice(0, 60) : ''}`;
  const t = c.kind === 'http' ? '' : ` ${tok(c.input_tokens)}↑${tok(c.output_tokens)}↓`;
  return `  [${c.seq}] ${c.call_id}  ${head}  ${stat}${t}`;
}

// ── 工具定义 ───────────────────────────────────────────────

export const TOOLS: Tool[] = [
  {
    name: 'list_runs',
    description:
      '列出最近的 agent 运行。返回 runId、调用数、token 用量、判定失败数。' +
      '脚本：一个进程 = 一次运行。常驻服务（HTTP server）：每个入站请求是一次请求级运行，' +
      '缩进列在它的进程运行下面，标着触发它的请求（如 POST /api/dispatch）—— 排查某个请求就用那个请求的 runId；' +
      '用进程的 runId 则代表它处理过的所有请求。' +
      'groups=true 改为列运行组（AGENTMAKE_GROUP 归的一批运行，或一个进程）。' +
      '通常是排查的第一步：先看有哪些运行，再用 find_failures 钻进去。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数，默认 10' },
        groupId: { type: 'string', description: '只列这个组里的运行' },
        groups: { type: 'boolean', description: 'true = 列运行组而不是运行' },
      },
    },
    async run({ limit = 10, groupId, groups }) {
      if (groups) {
        const gs = (await api('/api/groups')).slice(0, limit);
        if (!gs.length) return '还没有任何运行组。';
        return gs
          .map((g: any) =>
            `${g.group_id}  ${time(g.started_at)}  ${g.runs} 次运行` +
            (g.request_runs ? `（${g.request_runs} 个请求）` : '') +
            `  ${g.call_count} 次调用` + (g.failing ? `  ✗ ${g.failing} 处判定失败` : ''))
          .join('\n') + '\n→ list_runs({ groupId }) 看组里的运行';
      }
      const q = new URLSearchParams({ limit: String(groupId ? 200 : limit * 4) });
      if (groupId) q.set('groupId', groupId);
      const all = (await api(`/api/runs?${q}`)) as any[];
      if (!all.length) {
        return groupId ? `组 ${groupId} 里没有运行。` : '还没有任何运行。用 get_attach_command 拿到启动命令，跑一次 agent 再来。';
      }
      // 请求级运行缩进挂在它的进程下面；进程不在列表里（被 limit 截掉）的就单独列
      const byParent = new Map<string, any[]>();
      for (const r of all) if (r.parent_run_id) byParent.set(r.parent_run_id, [...(byParent.get(r.parent_run_id) ?? []), r]);
      const present = new Set(all.map((r) => r.run_id));
      const tops = all.filter((r) => !r.parent_run_id || !present.has(r.parent_run_id)).slice(0, limit);
      const out: string[] = [];
      for (const r of tops) {
        out.push(runLine(r));
        const kids = byParent.get(r.run_id) ?? [];
        for (const k of kids.slice(0, 8)) out.push(runLine(k, '    ↳ '));
        if (kids.length > 8) out.push(`    ↳ …还有 ${kids.length - 8} 个请求（list_runs({ groupId: '${r.group_id ?? r.run_id}' }) 看全部）`);
      }
      return out.join('\n');
    },
  },

  {
    name: 'find_failures',
    description:
      '★ 排查的首选入口。直接定位一次运行里出错的调用，并给出它的调用路径（哪个函数发起的）。' +
      '不只看 HTTP 报错：也包括「200 但答坏了」的 —— 规则自动判定的（被截断、空输出、工具参数不是合法 JSON、' +
      '调了没声明的工具、被安全策略拦截），以及之前用 score_call 判为失败的。每条都写明为什么算失败。' +
      '通常一次调用就够了 —— 不用先 list 再逐个翻 trace。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: '省略则查所有运行' } },
    },
    async run({ runId }) {
      const rows = await api(`/api/failures${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
      if (!rows.length) {
        return (runId ? `运行 ${runId} 没有失败的调用。` : '没有失败的调用。') +
          '（HTTP 层与规则判定都没发现问题；答案对不对还要看内容 —— 判完用 score_call 记下来）';
      }
      return rows
        .map((c: any) => {
          if (c.kind === 'run') {
            return [`运行 ${c.run_id}（整次运行的判定）`, ...c.failing.map((x: any) => `  ${scoreLine(x)}`)].join('\n');
          }
          const path = (parse(c.frames, []) as any[]).map((f) => f.fn).join(' → ');
          const httpFailed = !c.ok || c.error;
          return [
            `${c.call_id}  [seq ${c.seq}]  ${c.kind === 'http' ? `${c.method} ${c.url}` : `${c.provider}/${c.model}`}`,
            `  状态: ${httpFailed ? c.status || 'ERR' : `HTTP ${c.status}（请求成功，但判定失败）`}   耗时: ${c.duration_ms ?? '—'}ms`,
            ...(c.error ? [`  错误: ${clip(c.error, 400)}`] : []),
            ...(c.failing ?? []).map((x: any) => `  ${scoreLine(x)}`),
            `  调用路径: ${path || '（无）'}`,
            `  → 用 get_call('${c.call_id}') 看完整的请求内容`,
          ].join('\n');
        })
        .join('\n\n');
    },
  },

  {
    name: 'get_call',
    description:
      '★ 最高价值的工具。返回一次调用的完整内容：**实际发出去的 system prompt、messages、tools、参数**，' +
      '以及模型的实际响应（含它发起的工具调用与参数）、每条消息里回给模型的工具结果、token 用量、发起它的调用路径。' +
      '这是读代码推不出来的东西 —— f-string 拼接、列表截断、变量展开之后的最终形态。' +
      '改 prompt 前先看这个，不要靠猜。',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        maxChars: { type: 'number', description: '单段文本的最大字符数，默认 4000。prompt 很长时可调大' },
      },
      required: ['callId'],
    },
    async run({ callId, maxChars = 4000 }) {
      const c = await api(`/api/calls/${encodeURIComponent(callId)}`);
      const out: string[] = [];
      out.push(
        `调用 ${c.call_id}   ${c.kind === 'http' ? `${c.method} ${c.url}` : `${c.provider} / ${c.model}`}`,
        `状态 ${c.ok ? 'OK' : `失败 ${c.status ?? ''}`}   耗时 ${c.duration_ms ?? '—'}ms   ` +
          `tokens ${tok(c.input_tokens)}↑ ${tok(c.output_tokens)}↓` +
          (c.cache_read_tokens ? ` (cache ${c.cache_read_tokens})` : '') +
          (c.faked ? '   «响应是断点上伪造的»' : '') +
          (c.replaced ? '   «响应被断点改写过»' : ''),
      );

      const frames = parse(c.frames, []) as any[];
      if (frames.length) {
        out.push(`\n调用路径: ${frames.map((f) => f.fn).join(' → ')}`);
        const last = frames[frames.length - 1];
        out.push(`发起处: ${last.file}:${last.line}`);
      }

      if (c.error) out.push(`\n【错误】\n${clip(c.error, maxChars)}`);

      if (c.kind !== 'http') {
        if (c.system) out.push(`\n【SYSTEM PROMPT】(${String(c.system).length} 字符)\n${clip(c.system, maxChars)}`);
        const msgs = parse(c.messages, []) as any[];
        for (const [i, m] of msgs.entries()) {
          out.push(`\n【MESSAGE ${i + 1} · ${m.role}】(${m.content.length} 字符)\n${clip(m.content, maxChars)}`);
          for (const tc of m.toolCalls ?? []) out.push(`  ↳ 调用工具 ${clip(toolCallText(tc), maxChars)}`);
          for (const tr of m.toolResults ?? []) out.push(`  ↳ 工具结果 ${clip(toolResultText(tr), maxChars)}`);
        }
        const tools = parse(c.tools, []) as any[];
        if (tools.length) {
          out.push(`\n【TOOLS】\n${tools.map((t) => `- ${t.name}: ${t.description ?? ''}`).join('\n')}`);
        }
        const params = parse(c.params, {});
        if (Object.keys(params as object).length) out.push(`\n【参数】\n${JSON.stringify(params)}`);
        if (c.response_text) out.push(`\n【响应】\n${clip(c.response_text, maxChars)}`);
        // 列是 NULL 时 parse 得到 null，不是默认值
        const calls = (parse(c.response_tool_calls, []) ?? []) as any[];
        if (calls.length) {
          out.push(`\n【模型发起的工具调用】(${calls.length} 个)`);
          for (const tc of calls) out.push(`- ${clip(toolCallText(tc), maxChars)}`);
        }
      }
      const scores = (await api(`/api/scores?callId=${encodeURIComponent(callId)}`)) as any[];
      if (scores.length) {
        out.push(`\n【评分】`);
        for (const sc of scores) out.push(`- ${scoreLine(sc, maxChars)}`);
      }
      return out.join('\n');
    },
  },

  {
    name: 'list_calls',
    description:
      '列出一次运行里的所有调用（摘要，不含 prompt 全文）。看整体流程用；要具体内容再 get_call。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        kind: { type: 'string', description: "过滤 'llm' 或 'http'" },
        limit: { type: 'number', description: '默认 50' },
      },
    },
    async run({ runId, kind, limit = 50 }) {
      let rows: any[] = await api(`/api/calls${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
      if (kind) rows = rows.filter((r) => r.kind === kind);
      rows = rows.slice(0, limit);
      if (!rows.length) return '没有匹配的调用。';
      return `共 ${rows.length} 条：\n${rows.map(callLine).join('\n')}`;
    },
  },

  {
    name: 'search_calls',
    description:
      '在所有 prompt 与响应里全文搜索。适合「我记得 prompt 里有句…」「哪次调用提到了 X」这类查找。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        runId: { type: 'string' },
        limit: { type: 'number', description: '默认 20' },
      },
      required: ['query'],
    },
    async run({ query, runId, limit = 20 }) {
      const q = new URLSearchParams({ q: query, limit: String(limit) });
      if (runId) q.set('runId', runId);
      const rows: any[] = await api(`/api/search?${q}`);
      if (!rows.length) return `没有包含「${query}」的调用。`;
      return rows
        .map((c) => `${callLine(c)}\n      system: ${c.system_preview}\n      响应: ${c.response_preview}`)
        .join('\n');
    },
  },

  {
    name: 'get_graph',
    description:
      '返回从执行轨迹推导出的执行图：哪个函数调用了哪个函数、各自发起了多少次 LLM/HTTP 调用。' +
      '手写 agent 没有声明式拓扑，这张图是从实际跑过的调用栈反推的 —— ' +
      '所以它只反映跑过的路径，没出现的分支说明这次没覆盖到。',
    inputSchema: { type: 'object', properties: { runId: { type: 'string' } } },
    async run({ runId }) {
      const g = await api(`/api/graph${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
      if (!g.nodes.length) return '还没有可推导的执行图（这次运行没有捕获到任何调用）。';

      const byId = new Map(g.nodes.map((n: any) => [n.id, n]));
      const out = [`${g.nodes.length} 个函数 · ${g.totals.llm} 次 LLM · ${g.totals.http} 次 HTTP`];

      out.push(
        g.edges.length
          ? `\n调用关系：\n${g.edges
              .map((e: any) => `  ${(byId.get(e.from) as any)?.label} → ${(byId.get(e.to) as any)?.label}  ×${e.count}`)
              .join('\n')}`
          : '\n调用关系：（无嵌套 —— 所有调用都直接发自顶层，没有中间函数层级）',
      );

      out.push(
        `\n实际发起调用的函数：\n${g.nodes
          .filter((n: any) => n.ownCalls)
          .map(
            (n: any) =>
              `  ${n.label}  (${n.llmCalls} LLM, ${n.httpCalls} HTTP, ${n.ownMs}ms)  ${n.file}:${n.line}`,
          )
          .join('\n')}`,
      );
      return out.join('\n');
    },
  },

  {
    name: 'get_attach_command',
    description:
      '返回启动被调试 agent 的命令前缀。用它跑用户的 agent，运行过程就会被记录下来 —— 用户代码一行都不用改。' +
      '拿到命令后用你自己的终端工具执行，然后 list_runs 看结果。' +
      '带上 replayFrom=<runId> 会开启重放：与基线运行请求完全相同的调用直接用缓存的响应，' +
      '不花钱不等待；只有被你改动影响到的调用才真的打模型。改 prompt 做对比实验时务必用它。' +
      '常驻服务重启后重放，replayFrom 给上一个进程的 runId（或运行组），它处理过的所有请求都算基线。' +
      'group=<名字> 把这次启动的运行归进一个组，方便成批查看。',
    inputSchema: {
      type: 'object',
      properties: {
        replayFrom: { type: 'string', description: '基线：一次运行、一个进程运行或一个运行组；开启重放缓存' },
        group: { type: 'string', description: '运行组名（AGENTMAKE_GROUP），可选' },
        language: {
          type: 'string',
          description: 'node | python | other（其它语言走代理接入）。省略则三种都给',
        },
      },
    },
    async run({ replayFrom, language, group }) {
      const h = await api('/api/health');
      const replay = (replayFrom ? `AGENTMAKE_REPLAY=${replayFrom} ` : '') + (group ? `AGENTMAKE_GROUP=${group} ` : '');
      const lang = (language ?? '').toLowerCase();

      const node = `  ${replay}NODE_OPTIONS="--import ${h.harnessPath}" node your-app.mjs`;
      const py = [
        `  ${replay}PYTHONPATH="${h.pyHarnessPath}" python your_agent.py`,
        '  # 入口脚本里的循环要实时控制（改上限/跳出）时改用：',
        `  ${replay}PYTHONPATH="${h.pyHarnessPath}" python -m agentmake your_agent.py`,
      ].join('\n');
      const other = [
        '  # 其它语言：不用改代码，只改 base URL，agent 的请求经调试器转发',
        `  OPENAI_BASE_URL=${BASE}/p/openai/v1  <你的启动命令>`,
        `  ANTHROPIC_BASE_URL=${BASE}/p/anthropic  <你的启动命令>`,
        '  # 代价：看不到调用栈（画不出函数层级），其余能力一致',
      ].join('\n');

      const blocks =
        lang.startsWith('py') ? ['Python：', py]
        : lang === 'node' || lang === 'js' || lang === 'ts' ? ['Node：', node]
        : lang && lang !== 'auto' ? ['任意语言（代理接入）：', other]
        : ['Node：', node, '', 'Python：', py, '', other];

      return [
        '在被调试项目的目录下执行（把入口换成实际文件）：',
        '',
        ...blocks,
        '',
        replayFrom
          ? `重放已开启，基线 = ${replayFrom}。跑完用 compare_runs({ runB }) 对比 —— 不给 runA 会自动用这个基线。`
          : '跑完后用 list_runs 拿 runId，再用 find_failures / get_call / get_flow 钻进去。',
        `监视屏（人看的）：${BASE}`,
      ].join('\n');
    },
  },

  {
    name: 'compare_runs',
    description:
      '★ 对比两次运行：哪些调用完全相同、哪些请求变了、哪些响应变了，以及**第一处分歧发生在哪**。' +
      '改完 prompt 重跑之后用它 —— 第一处请求变化就是你的改动注入点，它之后的差异都是连锁反应，' +
      '不要把下游的必然变化误读成新问题。' +
      '用重放跑出来的运行可以只给 runB：自动以它的重放基线为 A；常驻服务的请求会对上基线里同一触发请求的同一次。',
    inputSchema: {
      type: 'object',
      properties: {
        runA: { type: 'string', description: '基线运行。省略则用 runB 的重放基线' },
        runB: { type: 'string', description: '改动后的运行' },
        maxPairs: { type: 'number', description: '最多列出多少对，默认 20' },
      },
      required: ['runB'],
    },
    async run({ runA, runB, maxPairs = 20 }) {
      const q = new URLSearchParams({ b: runB });
      if (runA) q.set('a', runA);
      const r = await api(`/api/compare?${q}`);
      if (r.error) return `对比失败：${r.error}`;
      runA = r.runA;
      const out = [
        `A=${runA} (${r.counts.a} 次 LLM, ${r.tokens.a} tok, 重放 ${r.replayed.a})`,
        `B=${runB} (${r.counts.b} 次 LLM, ${r.tokens.b} tok, 重放 ${r.replayed.b})`,
        `完全相同 ${r.counts.identical} · 请求变了 ${r.counts.requestChanged} · 响应变了 ${r.counts.responseChanged}`,
        r.divergeAt === null
          ? '\n两次运行的请求完全一致（若响应仍有差异，那是模型采样的随机性）。'
          : `\n★ 第一处分歧在第 ${r.divergeAt} 次调用 —— 那是改动的注入点，之后的差异多半是连锁反应。`,
        '',
      ];
      if (r.scores) {
        const v = { better: '变好了', worse: '变差了', mixed: '有好有坏', same: '失败判定没有变化' }[r.scores.verdict as string];
        out.push(
          `★ 评分：${v}   失败调用 A ${r.scores.a.failedCalls} → B ${r.scores.b.failedCalls}`,
          ...(r.scores.fixed.length ? [`  修好了: ${r.scores.fixed.join('、')}`] : []),
          ...(r.scores.introduced.length ? [`  新冒出来: ${r.scores.introduced.join('、')}`] : []),
          '',
        );
      }
      for (const p of r.pairs.slice(0, maxPairs)) {
        const mark = p.requestSame ? (p.responseSame ? '=' : '~') : '≠';
        out.push(`[${p.index}] ${mark} ${p.fn ?? '?'}  请求${p.requestSame ? '同' : `变(${p.changedIn})`}  响应${p.responseSame ? '同' : '变'}`);
        if (p.snippet) {
          out.push(`      A: …${clip(p.snippet.a, 120)}…`);
          out.push(`      B: …${clip(p.snippet.b, 120)}…`);
        }
        if (p.toolCalls) {
          out.push(`      工具 A: ${clip(p.toolCalls.a, 160)}`);
          out.push(`      工具 B: ${clip(p.toolCalls.b, 160)}`);
        }
        if (p.failing) {
          out.push(`      失败 A: ${p.failing.a.join(', ') || '—'}   B: ${p.failing.b.join(', ') || '—'}`);
        }
      }
      if (r.pairs.length > maxPairs) out.push(`…还有 ${r.pairs.length - maxPairs} 对（调大 maxPairs 查看）`);
      out.push('\n图例：= 完全相同  ~ 请求同但响应不同（模型随机性）  ≠ 请求不同');
      return out.join('\n');
    },
  },

  {
    name: 'check_writability',
    description:
      '★ 改 prompt 之前先问这个：某次调用里的 system / 某条 message，能不能定位回源码、能不能直接改。' +
      '返回 static_literal（源码里就是这个字符串，可精确替换）、static_composed（模板拼接，静态部分可改、${} 插值不可改）、' +
      'runtime_computed（值来自变量或外部数据，定位不到）。' +
      '⚠️ runtime_computed **不等于**「这段没法改」—— 它只是说没有捷径，你依然可以直接改产生它的那段代码。',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        field: { type: 'string', description: "'system' 或 'message:0'（下标）；默认 system" },
      },
      required: ['callId'],
    },
    async run({ callId, field = 'system' }) {
      const r = await api(`/api/writability?callId=${encodeURIComponent(callId)}&field=${encodeURIComponent(field)}`);
      if (r.error) return `分析失败：${r.error}`;
      const out = [`${field}: ${r.writability}`, r.note];
      if (r.file) out.push(`位置: ${r.file}:${r.line}`);
      if (r.segments?.length) {
        out.push(`\n可编辑片段（${r.segments.length} 段）：`);
        for (const [i, s] of r.segments.entries()) {
          out.push(`  [${i}] 行${s.line} 区间[${s.start},${s.end}]  ${JSON.stringify(clip(s.text, 100))}`);
        }
        out.push(`\n要改的话调 apply_source_edit，把 file / start / end / newText / fileHash 传回来。`);
        out.push(`fileHash = ${r.fileHash}（用于冲突检测，必须原样带上）`);
      }
      return out.join('\n');
    },
  },

  {
    name: 'apply_source_edit',
    description:
      '把改好的文本写回源码。参数来自 check_writability 返回的 segment。' +
      '写入前会做冲突检测（文件被别人改过就拒绝）、写入后用真解析器校验语法、并自动备份。' +
      '任何一步不过就整体放弃，文件保持原样。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string' },
        start: { type: 'number' },
        end: { type: 'number' },
        newText: { type: 'string' },
        fileHash: { type: 'string', description: 'check_writability 给的哈希，用于冲突检测' },
      },
      required: ['file', 'start', 'end', 'newText'],
    },
    async run(args) {
      const r = await post('/api/source/apply', args);
      if (!r.ok) return `未写入：${r.error}`;
      return [
        `已写入 ${args.file}`,
        `备份：${r.backup}（要回退就用这个路径调 revert_source_edit）`,
        `改动：${JSON.stringify(clip(r.before, 80))} → ${JSON.stringify(clip(r.after, 80))}`,
        '注意：被调试进程仍在跑旧代码，需要重启才生效。',
      ].join('\n');
    },
  },

  {
    name: 'revert_source_edit',
    description: '从备份还原一次源码改动。',
    inputSchema: {
      type: 'object',
      properties: { file: { type: 'string' }, backup: { type: 'string' } },
      required: ['file', 'backup'],
    },
    async run(args) {
      const r = await post('/api/source/revert', args);
      return r.ok ? `已还原 ${args.file}` : `还原失败：${r.error}`;
    },
  },

  {
    name: 'set_breakpoint',
    description:
      '设置断点。命中时被调试进程会真的阻塞住，等你用 resume 放行。四个位置：' +
      'llmBefore（改 prompt / 伪造响应）、llmAfter（改模型的回答，测下游怎么处理异常输出）、' +
      'httpBefore（伪造工具返回值，测异常分支不用真造故障）、httpAfter（改工具返回值）。' +
      '强烈建议配 once=true，否则每次调用都会停。工具断点建议配 urlContains，否则会被大量普通请求淹没。',
    inputSchema: {
      type: 'object',
      properties: {
        llmBefore: { type: 'boolean' },
        llmAfter: { type: 'boolean' },
        httpBefore: { type: 'boolean' },
        httpAfter: { type: 'boolean' },
        once: { type: 'boolean', description: '命中一次后自动解除，建议 true' },
        node: { type: 'string', description: '只在这个执行图节点下暂停，格式 file#fn' },
        urlContains: { type: 'string', description: '只对 URL 含此子串的调用生效' },
      },
    },
    async run(args) {
      const bp = await post('/api/breakpoints', args);
      const on = ['llmBefore', 'llmAfter', 'httpBefore', 'httpAfter'].filter((k) => (bp as any)[k]);
      return on.length
        ? `断点已设：${on.join(', ')}${bp.once ? '（只停一次）' : ''}` +
            `${bp.node ? ` node=${bp.node}` : ''}${bp.urlContains ? ` url含"${bp.urlContains}"` : ''}\n` +
            '现在去跑 agent。命中后用 list_paused 查看。'
        : '所有断点已关闭。';
    },
  },

  {
    name: 'list_paused',
    description: '列出当前停在断点上的调用。被调试进程正阻塞着等你决定。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const bp = await api('/api/breakpoints');
      if (!bp.pending?.length) return '当前没有挂起的调用。';
      return bp.pending
        .map(
          (p: any) =>
            `${p.callId}  阶段=${p.phase}  ${p.url}\n` +
            `  已暂停 ${Math.round((Date.now() - p.since) / 1000)}s\n` +
            `  调用路径: ${(p.frames ?? []).map((f: any) => f.fn).join(' → ')}\n` +
            `  → get_call('${p.callId}') 看内容，resume(...) 放行`,
        )
        .join('\n\n');
    },
  },

  {
    name: 'score_call',
    description:
      '记下你对一次调用（或整次运行）的判定：答对了没有。HTTP 200 不代表答对了 —— ' +
      '看完 get_call 发现答案错了、漏了、该调的工具没调，就用这个记成失败；之后 find_failures 会把它列出来，' +
      'compare_runs 会告诉你改完之后它有没有被修好。' +
      '同一目标、同一个 name 再打一次是覆盖（改完重跑后重判就用同一个 name）。' +
      '★ comment 写清楚理由：哪里错、期望是什么 —— 它是给之后的你和用户看的。',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: '给某次调用打分。和 runId 二选一' },
        runId: { type: 'string', description: '给整次运行打分（例如最终结果对不对）' },
        name: {
          type: 'string',
          description: '判定维度，短而稳定，如 correct / priority_right / used_search。同名才能跨运行对比',
        },
        passed: { type: 'boolean', description: 'true 通过 / false 失败' },
        value: { type: 'number', description: '可选的数值分，如 0~1 的质量分' },
        label: { type: 'string', description: '可选的分类标签，如 hallucination / truncated_history' },
        comment: { type: 'string', description: '理由。强烈建议写' },
      },
      required: ['name', 'passed'],
    },
    async run({ callId, runId, name, passed, value, label, comment }) {
      if (!callId && !runId) return '需要 callId 或 runId 之一。';
      const res = await fetch(`${BASE}/api/scores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callId, runId, name, passed, value, label, comment, source: 'ai' }),
        signal: AbortSignal.timeout(20_000),
      }).catch((e) => {
        throw new Error(`连不上 AgentMake 调试器（${BASE}）：${e?.message ?? e}`);
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
      return `已记下：${scoreLine(r)}\n目标：${r.call_id ? `调用 ${r.call_id}` : `运行 ${r.run_id}`}` +
        (r.passed === 0 ? '\n改完重跑后，用同一个 name 再判一次，compare_runs 会显示它有没有被修好。' : '');
    },
  },

  {
    name: 'resume',
    description:
      '放行一个停在断点上的调用，可同时改写内容。action：' +
      "continue=原样放行；patch=改请求（仅 llm.before，patch 里只放要改的字段，其余原样透传）；" +
      "fake=不真的调用，直接造一个响应回去；replace=改写已收到的响应（llm.after/http.after）；abort=把错误抛进用户代码。",
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        phase: { type: 'string', description: 'llm.before | llm.after | http.before | http.after' },
        action: { type: 'string', description: 'continue | patch | fake | replace | abort' },
        patch: {
          type: 'object',
          description: '仅 action=patch。可含 system / messages / model / params，只放要改的',
        },
        text: { type: 'string', description: 'fake/replace 的文本内容（LLM 调用）' },
        status: { type: 'number', description: 'fake/replace 的 HTTP 状态码（工具调用）' },
        body: { type: 'string', description: 'fake/replace 的响应体（工具调用）' },
        armNext: { type: 'boolean', description: '放行后立刻停在下一次同类调用（单步）' },
      },
      required: ['callId', 'phase', 'action'],
    },
    async run(args) {
      const r = await post('/api/resume', args);
      return r.ok
        ? `已放行 ${args.callId}（${args.action}）${args.armNext ? '，并已武装下一次断点' : ''}`
        : `放行失败：找不到挂起的调用 ${args.callId}（可能已超时自动放行，或阶段填错了）`;
    },
  },

  // ── 流程与循环：AI 在页面之外也要看得到 agent 的语义结构、控得住循环 ──

  {
    name: 'get_anomalies',
    description:
      '★ 自动发现的异常（页面上「需要你看的」那一栏）：数据在进 prompt 前被丢掉、规则判定失败、调用失败、' +
      '比平时慢、循环比平时多转、同一个请求发了好几遍、工具返回空。按影响排序，每条带着相关步骤和典型调用 id。' +
      '比 find_failures 多一类最难发现的问题：每一步都是 200、但上游的数据没有全部进到下游的 prompt 里。' +
      '拿到「数据被丢掉」后，用 trace_prompt 看那次调用的 prompt 缺了哪几条、可能是哪行代码丢的。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: '运行 / 进程 / 运行组；默认最近一次运行' } },
    },
    async run({ runId }) {
      const f = await api(`/api/flow${runId ? `?runId=${encodeURIComponent(runId)}` : ''}`);
      const list = (f.anomalies ?? []) as any[];
      if (!list.length) return `运行 ${f.runId ?? ''} 没发现异常（数据丢失、规则失败、调用失败、慢、循环多转、重复请求、空数据都查过了）。`;
      const label = (id: string) => f.steps.find((s: any) => s.id === id)?.label ?? id;
      const sev = { fail: '结果错了', warn: '很可能有问题', info: '值得一看' } as Record<string, string>;
      return list.map((a) => [
        `${a.icon} ${a.title}  [${sev[a.severity] ?? a.severity}]  ${a.count}`,
        `  ${a.detail}`,
        a.stepIds.length ? `  步骤: ${a.stepIds.map(label).join(' → ')}` : '',
        a.callIds.length ? `  典型调用: ${a.callIds.slice(-3).join(', ')}${a.kind === 'data_dropped' ? `  → trace_prompt('${a.callIds.at(-1)}')` : ''}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
    },
  },

  {
    name: 'trace_prompt',
    description:
      '★ 把一次模型调用的 prompt 按来源拆开：哪段是源码里的模板（文件:行，可写回）、哪段来自哪次工具调用的第几条、' +
      '哪段来自前面哪一步模型的回答、哪段是运行时拼的。并列出「上游给了却没进 prompt」的那几条，' +
      '以及附近代码里可疑的截断写法（slice(-5) / [:5] / truncate / limit）。' +
      '答错了先用它看「模型当时到底看到了什么、少看到了什么」，比读代码猜快得多。',
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string' },
        maxChars: { type: 'number', description: '每段文字最多显示多少字，默认 200' },
      },
      required: ['callId'],
    },
    async run({ callId, maxChars = 200 }) {
      const a = await api(`/api/calls/${encodeURIComponent(callId)}/anatomy`);
      const total = Object.values(a.totals as Record<string, number>).reduce((n, x) => n + x, 0) || 1;
      const pct = (k: string) => Math.round(((a.totals[k] ?? 0) / total) * 100);
      const name = { template: '模板', tool: '工具结果', llm: '模型回答', other: '运行时拼的' } as Record<string, string>;
      const out: string[] = [
        `调用 ${callId} 的 prompt 构成：` +
          Object.keys(name).filter((k) => a.totals[k]).map((k) => `${name[k]} ${pct(k)}%`).join(' · '),
      ];
      for (const d of a.dropped) {
        out.push(`\n✂ 没进 prompt：${d.from} 给了 ${d.total} 条，只用了 ${d.used} 条。缺的是：`);
        for (const it of d.items.slice(0, 10)) out.push(`  #${it.index} ${clip(it.text, maxChars)}`);
      }
      if (a.suspects.length) {
        out.push('\n可能是这几行把数据丢掉的：');
        for (const x of a.suspects) out.push(`  ${x.file}:${x.line}  [${x.reason}]  ${x.code}`);
      }
      out.push('\n逐段来源：');
      for (const p of a.parts) {
        out.push(`【${p.key === 'system' ? 'SYSTEM' : `${p.role} · 第 ${Number(p.key.split(':')[1]) + 1} 条`}】`);
        for (const sg of p.segments) {
          const src = sg.source === 'template' ? `模板 ${sg.file ? `${sg.file}:${sg.line}` : ''}`
            : sg.source === 'tool' ? `来自 ${sg.from}${sg.items.length ? ` 第 ${sg.items.join(',')} 条` : ''}（${sg.callId}）`
            : sg.source === 'llm' ? `来自 ${sg.from} 的回答（${sg.callId}）`
            : '运行时拼的';
          out.push(`  [${src}] ${clip(sg.text, maxChars)}`);
        }
      }
      return out.join('\n');
    },
  },

  {
    name: 'compare_step',
    description:
      '同一个步骤在一次运行（或一个进程处理过的所有请求）里每次的表现排成一张表：上游给了多少、用了多少、丢的是什么、' +
      '这一步输出了什么、下一步去了哪、有没有被判失败。并自动总结规律 —— 比如「数据被丢掉的那几次都判成 normal，' +
      '没丢的都判成 urgent」。用来确认一个 bug 是偶发还是必然、是不是就是那处数据丢失造成的。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '进程或运行组的 runId（看它处理过的所有请求）；默认最近一次运行' },
        step: { type: 'string', description: '步骤名（如 analyze）或 get_flow 里的步骤 id' },
        limit: { type: 'number', description: '最多列多少行，默认 20' },
      },
      required: ['step'],
    },
    async run({ runId, step, limit = 20 }) {
      const q = new URLSearchParams({ stepId: step });
      if (runId) q.set('runId', runId);
      const r = await api(`/api/steps/compare?${q}`);
      const out = [`步骤 ${r.step.label}：${r.rows.length} 次${r.step.calls > r.rows.length ? `（共 ${r.step.calls} 次）` : ''}`];
      if (r.pattern) out.push(`★ 规律：${r.pattern}`);
      out.push('');
      for (const x of r.rows.slice(0, limit)) {
        const inp = x.input;
        const feed = !inp ? '—'
          : inp.items != null && inp.used != null ? `${inp.items}→${inp.used} 条${inp.used < inp.items ? ' ✂' : ''}`
          : inp.coverage != null ? `进了 ${Math.round(inp.coverage * 100)}%` : `${inp.bytes}B`;
        out.push(
          `${x.callId}  ${x.runId ?? ''}${x.trigger ? ` ${x.trigger}` : ''}  上游 ${feed}` +
          `${inp?.missing?.length ? `  缺：${inp.missing.map((m: string) => `「${clip(m, 30)}」`).join('')}` : ''}` +
          `  → 输出 ${clip(x.out, 60)}  → 下一步 ${x.next ?? '（结束）'}` +
          `${x.failing.length ? `  ✗ ${x.failing.join(',')}` : ''}`,
        );
      }
      return out.join('\n');
    },
  },

  {
    name: 'verify_run',
    description:
      '★ 改完代码重跑之后用它：把改动后的运行和基线**按步骤**对齐（不按调用序号 —— 修好后常常走了另一条分支），' +
      '标出 ★ 注入点（改动生效的第一步，之后的变化是连锁反应），每一步前后的输入 / 输出 / 走向 / 是否走了缓存，' +
      '以及结论：修好了哪几处、新冒出来哪几处、哪几处还在。只给 runB 时自动用它的重放基线。' +
      '想看某一步具体差在哪，带上 step 拿那一步的 prompt / 输出逐行差异。',
    inputSchema: {
      type: 'object',
      properties: {
        runB: { type: 'string', description: '改动后的运行' },
        runA: { type: 'string', description: '基线；省略则用 runB 的重放基线' },
        step: { type: 'string', description: '可选：步骤名，返回这一步的 prompt / 输出差异' },
      },
      required: ['runB'],
    },
    async run({ runA, runB, step }) {
      const q = new URLSearchParams({ b: runB });
      if (runA) q.set('a', runA);
      const v = await api(`/api/verify?${q}`);
      const word = { better: '✓ 变好了', worse: '✗ 变差了', mixed: '有好有坏', same: '结论没变' } as Record<string, string>;
      const out = [
        `A=${v.a}（改之前） ⇄ B=${v.b}（改之后）`,
        `★ 结论：${word[v.verdict]}`,
        ...(v.fixed.length ? [`  修好了：${v.fixed.join('、')}`] : []),
        ...(v.introduced.length ? [`  新冒出来：${v.introduced.join('、')}`] : []),
        ...(v.remaining.length ? [`  还在：${v.remaining.join('、')}`] : []),
        `  模型调用真打 ${v.cost.bReal} 次、走缓存 ${v.cost.bReplayed} 次 · tokens ${v.cost.aTokens} → ${v.cost.bTokens}`,
        '',
        '逐步对齐：',
      ];
      const st = { same: '没变', changed: '变了', only_a: '改之后没再执行', only_b: '改之后第一次走到' } as Record<string, string>;
      const sideText = (x: any) => !x ? '—'
        : `${x.input?.items != null && x.input?.used != null ? `看到 ${x.input.used}/${x.input.items} 条 · ` : ''}${clip(x.out, 50)}${x.next ? ` → ${x.next}` : ''}${x.failing.length ? ` ✗${x.failing.join(',')}` : ''}`;
      for (const p of v.pairs) {
        out.push(`${p.star ? '★' : ' '} ${p.label} [${st[p.status]}]  A: ${sideText(p.a)}  |  B: ${sideText(p.b)}${p.b && p.kind === 'llm' ? `  (真打 ${p.b.real} / 缓存 ${p.b.replayed})` : ''}`);
      }
      if (step) {
        const p = v.pairs.find((x: any) => x.label === step);
        if (!p?.a || !p?.b) out.push(`\n步骤 ${step} 只在一边执行过，没有可比的差异。`);
        else {
          const d = await api(`/api/verify/diff?a=${encodeURIComponent(p.a.callIds[0])}&b=${encodeURIComponent(p.b.callIds[0])}`);
          const fmt = (xs: any[]) => xs.filter((x) => x.op !== 'same').map((x) => `${x.op === 'add' ? '+' : '-'} ${clip(x.text, 160)}`).join('\n') || '（没变）';
          out.push(`\n【${step} 的 prompt 差异】\n${fmt(d.prompt)}`, `\n【${step} 的输出差异】\n${fmt(d.output)}`);
        }
      }
      return out.join('\n');
    },
  },

  {
    name: 'run_regression',
    description:
      '★ 拿历史上的真实请求批量回归：把基线进程处理过的请求（入站请求本身被探针记下来了）原样重发给改好的服务，' +
      '逐个和当时的结果对比 —— 原来出过问题的改对了几个、原来好好的有没有被改坏。' +
      '没改动的模型调用按各自的基线命中缓存，只为变化的部分付钱。前提：改好的服务已经带着探针在跑（会自动找到它）。' +
      '只支持 Node 常驻服务。',
    inputSchema: {
      type: 'object',
      properties: {
        baseline: { type: 'string', description: '出过问题的那个进程的 runId（或运行组）' },
        target: { type: 'string', description: '改好的服务的进程 runId；省略则自动找基线之后起来、还在跑的那个' },
        only: { type: 'string', description: 'all（默认）| failed：只回归出过问题的' },
        limit: { type: 'number', description: '最多回归多少个请求，默认 50' },
        waitSeconds: { type: 'number', description: '最多等多久出结果，默认 120 秒；没跑完就返回当前进度和批次 id' },
      },
      required: ['baseline'],
    },
    async run({ baseline, target, only, limit, waitSeconds = 120 }) {
      const res = await fetch(`${BASE}/api/regress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseline, target, only, limit }),
        signal: AbortSignal.timeout(20_000),
      });
      let b = await res.json();
      if (!res.ok || b.error) throw new Error(b.error ?? `HTTP ${res.status}`);
      const t0 = Date.now();
      while (!b.done && Date.now() - t0 < waitSeconds * 1000) {
        await new Promise((r) => setTimeout(r, 1000));
        b = await api(`/api/regress/${b.id}`);
      }
      const s = b.summary;
      const wasBad = b.items.filter((x: any) => x.before.failed).length;
      const word = { fixed: '改对了', still: '还有问题', ok: '没变坏', regressed: '被改坏了', error: '出错' } as Record<string, string>;
      return [
        `批次 ${b.id} · 目标 ${b.target}（${b.url}）· ${b.done ? '完成' : `进行中（${b.items.filter((x: any) => x.outcome).length}/${b.items.length}）`}`,
        `★ 原来出过问题的 ${wasBad} 个：${s.fixed} 个改对了${s.still ? `，${s.still} 个还有问题` : ''}`,
        `★ 原来就好的 ${b.items.length - wasBad} 个：${s.regressed ? `${s.regressed} 个被改坏了` : `${s.ok} 个没变坏`}`,
        `模型调用真打 ${s.real} 次、走缓存 ${s.replayed} 次${s.error ? ` · ${s.error} 个出错` : ''}`,
        '',
        ...b.items.map((x: any) =>
          `${x.baseline} → ${x.run ?? '—'}  ${x.trigger}  ${x.outcome ? word[x.outcome] : x.status}` +
          `${x.changed.length ? `  变了：${x.changed.join(' · ')}` : ''}` +
          `${x.after?.issues?.length ? `  仍有：${x.after.issues.join('、')}` : ''}${x.error ? `  ${x.error}` : ''}`),
        b.done ? '' : `\n还没跑完 —— 稍后再调一次 run_regression 不会续上，请用 verify_run 看已完成的那几个，或在页面「验证」里看进度`,
      ].join('\n');
    },
  },

  {
    name: 'get_flow',
    description:
      'Agent 语义流程图：步骤（哪一行代码发的调用）、循环轮次、分支（哪几轮没走）、并发、每步输入输出摘要。' +
      '和 get_graph 的区别：get_graph 是函数调用图（技术视角），这个是 agent 在干什么（语义视角）。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '默认最近一次运行' },
        maxChars: { type: 'number', description: '每条输入/输出摘要的上限，默认 160' },
      },
    },
    async run(args) {
      const q = args.runId ? `?runId=${encodeURIComponent(args.runId)}` : '';
      const f = await api(`/api/flow${q}`);
      if (!f.steps.length) return '这次运行没有捕获到任何调用。';
      const max = args.maxChars ?? 160;

      const out: string[] = [
        `运行 ${f.runId}`,
        `${f.steps.length} 步 · ${f.totals.llm} 次 LLM · ${f.totals.tool} 次工具 · ` +
          `${f.totals.ms}ms · ${f.totals.inputTokens}↑ ${f.totals.outputTokens}↓` +
          (f.totals.errors ? ` · ${f.totals.errors} 次失败` : ''),
        '',
      ];

      for (const l of f.loops) {
        const state = l.running
          ? `正在跑，第 ${l.iterations} 轮`
          : `共 ${l.iterations} 轮，退出原因=${l.exitReason ?? '未知'}`;
        out.push(
          `循环 ${l.id}`,
          `  ${state}${l.maxOverride != null ? `（运行时上限被改成 ${l.maxOverride}）` : ''}`,
          `  → set_loop('${l.id}', ...) 改上限 / 跳出 / 再来一轮 / 每轮暂停`,
        );
      }
      if (f.loops.length) out.push('');

      let row = -1;
      for (const s of f.steps) {
        if (s.row !== row) {
          row = s.row;
          const peers = f.steps.filter((x: any) => x.row === row);
          if (peers.length > 1) out.push(`— 以下 ${peers.length} 步并发 —`);
        }
        const flags = [
          s.loopId ? `在循环内，跑过第 ${s.iterations.join('/')} 轮` : '',
          s.conditional ? '分支（不是每轮都跑）' : '',
          s.concurrency > 1 ? `并发 ×${s.concurrency}` : '',
          s.errors ? `${s.errors} 次失败` : '',
        ].filter(Boolean);
        out.push(
          `[${s.kind === 'llm' ? 'LLM' : '工具'}] ${s.label} @ ${s.file}:${s.line}  ×${s.calls}  ${s.ms}ms` +
            (s.model ? `  ${s.model}` : ''),
        );
        if (flags.length) out.push(`  ${flags.join(' · ')}`);
        out.push(
          `  入: ${clip(s.preview?.in, max)}`,
          `  出: ${clip(s.preview?.out, max)}`,
          `  调用: ${s.callIds.slice(0, 8).join(' ')}${s.callIds.length > 8 ? ` …共 ${s.callIds.length} 次` : ''}`,
          '',
        );
      }
      return out.join('\n');
    },
  },

  {
    name: 'list_loops',
    description: '列出被插桩到的循环及其当前轮次、运行时覆写。循环是 agent 最难调的部分：改一次上限要改代码重跑。',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const d = await api('/api/loops');
      if (!d.loops?.length) return '还没有看到任何循环。（循环插桩只覆盖被 --import 加载的模块）';
      return d.loops
        .map((l: any) => {
          const o = d.overrides?.[l.loopId] ?? {};
          const ov = [
            o.maxIterations != null ? `上限=${o.maxIterations}` : '',
            o.breakpoint ? '每轮暂停' : '',
            o.breakNow ? '待跳出' : '',
            o.forceOneMore ? '待强制再来一轮' : '',
          ].filter(Boolean);
          return (
            `${l.loopId}\n` +
            `  运行 ${l.runId} · 第 ${l.iteration} 轮 · ${Math.round((Date.now() - l.at) / 1000)}s 前\n` +
            (ov.length ? `  覆写: ${ov.join('、')}\n` : '') +
            `  → set_loop('${l.loopId}', { maxIterations / breakNow / forceOneMore / breakpoint })`
          );
        })
        .join('\n\n');
    },
  },

  {
    name: 'set_loop',
    description:
      '实时改一个循环的行为，**不改代码、不重跑**，跑着的时候就生效。' +
      'maxIterations=改上限（null 表示交还给源码）；breakNow=下一次条件求值直接跳出；' +
      'forceOneMore=原条件已为假时也强制再跑一轮；breakpoint=每轮开始时暂停（配合 resume_loop）。',
    inputSchema: {
      type: 'object',
      properties: {
        loopId: { type: 'string', description: '形如 /abs/path/file.mjs:16，来自 list_loops / get_flow' },
        maxIterations: { type: ['number', 'null'] },
        breakNow: { type: 'boolean' },
        forceOneMore: { type: 'boolean' },
        breakpoint: { type: 'boolean' },
      },
      required: ['loopId'],
    },
    async run(args) {
      const r = await post('/api/loops', args);
      const o = r.override ?? {};
      return (
        `已设置 ${args.loopId}\n` +
        `  当前覆写: 上限=${o.maxIterations ?? '（源码）'}` +
        `${o.breakpoint ? ' · 每轮暂停' : ''}${o.breakNow ? ' · 待跳出' : ''}` +
        `${o.forceOneMore ? ' · 待强制再来一轮' : ''}\n` +
        '  覆写在下一轮开始时被 harness 取走，随后一次条件求值生效。'
      );
    },
  },

  {
    name: 'resume_loop',
    description: '放行一个停在轮次边界上的循环（先用 set_loop 的 breakpoint 停住它）。action：continue=继续这一轮；break=直接跳出循环。',
    inputSchema: {
      type: 'object',
      properties: {
        loopId: { type: 'string' },
        action: { type: 'string', description: 'continue | break' },
      },
      required: ['loopId', 'action'],
    },
    async run(args) {
      const r = await post('/api/loop-resume', args);
      return r.ok
        ? `已放行循环 ${args.loopId}（${args.action}）`
        : `没有找到停在轮次边界上的循环 ${args.loopId}（可能已经自己走了）`;
    },
  },

  // ── 规格：让 AI 看得见「用户要什么」，而不只是「它实际怎么跑」 ──
  //
  // 前面那些工具解决的是 AI 的"盲改"问题（看不见运行时）。这一组解决另一半：
  // AI 也看不见用户的意图 —— 自然语言描述又散又含糊。用户在页面上画的规格
  // 是一份结构化的、可对账的意图，比一段话精确得多。
  //
  // 闭环：读规格 → 改代码 → 跑一次 → diff_spec 拿到差异 → 继续改，直到差异清零。

  {
    name: 'get_spec',
    description:
      '读用户在页面上画的 agent 规格（意图图）：每一步要做什么、连线顺序、循环上限、哪些是分支。' +
      '**动手改 agent 代码之前先读这个** —— 它是用户想要的样子，而 get_flow 是它现在的样子。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '规格名，默认 agent' } },
    },
    async run(args) {
      const name = args.name ?? 'agent';
      const spec = await api(`/api/spec?name=${encodeURIComponent(name)}`);
      if (!spec.steps?.length) {
        return (
          `规格「${name}」还是空的。\n` +
          '用户还没画，或者可以先跑一次 agent 再调 draft_spec_from_run 生成草稿。'
        );
      }
      return specText(spec);
    },
  },

  {
    name: 'set_spec',
    description:
      '写回规格。典型用法：用户让你「把这一步加进规格」「把循环上限改成 3」，' +
      '或者你实现了新步骤后把它补进规格好让后续对账不再报 unexpected。' +
      '整份覆盖 —— 先 get_spec 读出来，改完再整份写回，别凭空构造。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        goal: { type: 'string', description: '一句话说明这个 agent 干什么' },
        steps: {
          type: 'array',
          description:
            '步骤数组。每项：{ id, kind: llm|tool|loop, label, intent?, prompt?, model?, ' +
            'parentId?（属于哪个循环步骤的 id）, after?（前置步骤 id 数组）, optional?（是分支）, ' +
            'parallel?（可并发）, maxIterations?（kind=loop）, bind?（绑到实际步骤 id） }',
          items: { type: 'object' },
        },
      },
      required: ['steps'],
    },
    async run(args) {
      const name = args.name ?? 'agent';
      const saved = await post('/api/spec', { name, goal: args.goal ?? '', steps: args.steps });
      return `规格「${saved.name}」已保存，共 ${saved.steps.length} 步。页面上会立刻刷新。`;
    },
  },

  {
    name: 'draft_spec_from_run',
    description:
      '按一次真实运行反推出规格草稿（步骤、循环轮数、分支、绑定关系都自动填好）。' +
      '从零画图门槛太高 —— 先跑一次拿到起点，再往上改意图。会覆盖同名规格。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        runId: { type: 'string', description: '默认最近一次运行' },
      },
    },
    async run(args) {
      const spec = await post('/api/spec/from-run', {
        name: args.name ?? 'agent',
        runId: args.runId,
      });
      if (spec.error) throw new Error(spec.error);
      return `已按实际运行生成规格草稿：\n\n${specText(spec)}`;
    },
  },

  {
    name: 'diff_spec',
    description:
      '★ 把规格（用户要什么）和一次真实运行（它实际怎么跑）对上，列出所有差异：' +
      '画了但没跑到的步骤、跑了但没画的步骤（藏着的重试/fallback）、顺序不一致、' +
      '循环超轮、没标成分支却只在部分轮跑、失败。' +
      '**改完代码跑一次之后调它** —— 差异清零才算做对了。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        runId: { type: 'string', description: '默认最近一次运行' },
      },
    },
    async run(args) {
      const q = new URLSearchParams({ name: args.name ?? 'agent' });
      if (args.runId) q.set('runId', args.runId);
      const d = await api(`/api/spec/diff?${q}`);

      const head =
        `规格「${d.spec.name}」 vs 运行 ${d.runId ?? '（无）'}\n` +
        `对上 ${d.coverage.matched}/${d.coverage.total} 步` +
        (d.coverage.unexpected ? `，另有 ${d.coverage.unexpected} 个实际步骤没在规格里` : '');

      if (!d.findings.length) {
        return `${head}\n\n✓ 没有差异 —— 实际行为和规格一致。`;
      }

      const lines = d.findings.map((f: any) => {
        const tag = { blocker: '✗', warn: '!', info: '·' }[f.level as string] ?? '·';
        const extra = f.candidates?.length
          ? `\n      候选：${f.candidates.map((c: any) => `${c.label}（${c.id}）`).join('、')}`
          : '';
        return `  ${tag} [${f.kind}] ${f.message}${extra}`;
      });
      return `${head}\n\n${lines.join('\n')}\n\n（✗ = 你的心智模型和现实不符，优先处理）`;
    },
  },
];

/** 规格的紧凑文本形式 —— 直接倾倒 JSON 太费 token */
function specText(spec: any): string {
  const out = [`规格「${spec.name}」`];
  if (spec.goal) out.push(`目标：${spec.goal}`);
  out.push('');
  for (const s of spec.steps ?? []) {
    const kind = s.kind === 'loop' ? `循环${s.maxIterations ? `（最多 ${s.maxIterations} 轮）` : ''}`
      : s.kind === 'llm' ? 'LLM' : '工具';
    const tags = [
      kind,
      s.parentId ? `在 ${s.parentId} 内` : '',
      s.optional ? '可选（分支）' : '',
      s.parallel ? '可并发' : '',
      s.after?.length ? `在 ${s.after.join(',')} 之后` : '',
      s.bind ? '已绑定实际步骤' : '未绑定',
    ].filter(Boolean);
    out.push(`[${s.id}] ${s.label}  ${tags.join(' · ')}`);
    if (s.intent) out.push(`  意图：${s.intent}`);
    if (s.prompt) out.push(`  prompt：${clip(s.prompt, 200)}`);
    if (s.model) out.push(`  模型：${s.model}`);
  }
  return out.join('\n');
}
