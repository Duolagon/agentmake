// 判断一次 fetch 是不是 LLM 调用，以及属于哪家协议。
//
// 按「请求形状」而非 SDK 识别：目标项目直接裸调 fetch，没有 SDK 可以 patch。
// 这反而更稳 —— 不受 SDK 版本漂移影响，也能覆盖任何自研 HTTP 封装。
//
// ⚠️ 关键设计：以 **路径形状** 为主判据，host 只做辅助。
// 早期版本要求官方域名（generativelanguage.googleapis.com / api.anthropic.com），
// 结果是一旦用户走代理或网关（LiteLLM、自建中转、企业出口）就全部识别不出来 ——
// 而这在真实项目里非常普遍。路径形状是协议的一部分，代理不会改它。

import type { ProviderKind } from './types.ts';

export type Classification = {
  kind: ProviderKind;
  /** 从 URL 里能直接提取到的模型名（Gemini 把模型放在路径里，别处放在 body） */
  modelFromUrl: string | null;
};

const NOT_LLM: Classification = { kind: 'unknown', modelFromUrl: null };

export type HeaderLike = Headers | Record<string, unknown> | undefined | null;

function headerGet(h: HeaderLike, name: string): string | null {
  if (!h) return null;
  if (h instanceof Headers) return h.get(name);
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === lower) return v == null ? null : String(v);
  }
  return null;
}

export function classify(url: string, method: string, headers?: HeaderLike): Classification {
  if (method.toUpperCase() !== 'POST') return NOT_LLM;

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return NOT_LLM;
  }

  const host = u.hostname.toLowerCase();
  const path = u.pathname;

  // Gemini / Vertex：`:generateContent` 这个动作后缀是 Gemini 协议独有的，
  // 全网没有别的 API 长这样，所以只看路径就足够可靠。
  if (/:(stream)?generateContent$/i.test(path)) {
    const m = path.match(/\/models\/([^:/]+):/);
    return { kind: 'gemini', modelFromUrl: m ? decodeURIComponent(m[1]) : null };
  }

  // Anthropic Messages：`/messages` 这个路径本身不够独特（别的 API 也可能有），
  // 所以要求一个佐证信号 —— anthropic-version 头是 Anthropic API 的必填项，
  // 任何调用方（含代理）都会带上，是最可靠的判据。
  if (/\/messages\/?$/.test(path)) {
    const corroborated =
      host.endsWith('anthropic.com') ||
      headerGet(headers, 'anthropic-version') != null ||
      headerGet(headers, 'x-api-key') != null ||
      u.searchParams.has('anthropic-version');
    if (corroborated) return { kind: 'anthropic', modelFromUrl: null };
  }

  // OpenAI 及一切兼容端点（DeepSeek / 智谱 / Kimi / 本地 vLLM / LiteLLM…）
  // host 是开放集合，枚举不完，只认路径。
  if (/\/chat\/completions\/?$/.test(path)) {
    return { kind: 'openai', modelFromUrl: null };
  }

  // OpenAI Responses API。`/responses` 太泛（问卷、表单服务都可能有），要求挂在版本号或 openai 路径下：
  // /v1/responses、Azure 的 /openai/v1/responses、/openai/responses
  if (/\/(v\d+|openai)(\/v\d+)?\/responses\/?$/.test(path)) {
    return { kind: 'openai_responses', modelFromUrl: null };
  }

  return NOT_LLM;
}

/** 请求头里可能带密钥的字段，上报前一律抹掉 */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

export function redactHeaders(headers: HeaderLike): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  for (const [k, v] of entries) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '«redacted»' : String(v);
  }
  return out;
}
