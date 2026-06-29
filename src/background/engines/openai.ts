/**
 * OpenAI 兼容引擎实现（架构 4.4 / 7.2）。
 *
 * 覆盖 OpenAI 官方 / DeepSeek / 任意 OpenAI 兼容 chat completions endpoint。
 * 原生 fetch，无 SDK。支持 `response_format:{type:"json_object"}` 强制结构化输出。
 *
 * 安全：明文 API Key 在 translate 时才从 secret-store 解密（用时取，不常驻内存），
 * 仅放入请求头发出，不落盘、不打印。
 */
import {
  EngineError,
  type Engine,
  type TranslateRequest,
  type TranslateResponse,
  type TranslateUsage,
} from './adapter';
import type { SecretStore } from '../config/secret-store';

export interface OpenAIEngineOptions {
  id: string;
  label?: string;
  provider: 'openai' | 'openai-compatible';
  /** API 根地址，可带或不带 /v1，可含或不含 /chat/completions。 */
  baseUrl: string;
  model: string;
  /** secret-store 引用，运行时解密取明文 key。 */
  apiKeyRef: string;
  secretStore: SecretStore;
  /** 可注入 fetch（测试 mock）；生产用全局 fetch（MV3 SW 可用）。 */
  fetchFn?: typeof fetch;
}

/** OpenAI chat completions 请求体（仅本实现用到的字段）。 */
export interface OpenAIChatRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  /** 翻译需确定性输出。 */
  temperature: 0;
  response_format?: { type: 'json_object' };
  stream?: false;
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * 解析 baseUrl 为完整 chat completions endpoint。
 * 兼容用户填写的各种形式：
 *   https://api.openai.com            -> …/v1/chat/completions
 *   https://api.openai.com/v1         -> …/v1/chat/completions
 *   https://api.deepseek.com/v1       -> …/v1/chat/completions
 *   https://example.com/v1/chat/completions -> 原样
 */
export function resolveChatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 构造请求体（导出便于单测断言 JSON 结构）。 */
export function buildRequestBody(
  model: string,
  req: TranslateRequest,
): OpenAIChatRequest {
  const body: OpenAIChatRequest = {
    model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userMessage },
    ],
    temperature: 0,
  };
  if (req.jsonMode) body.response_format = { type: 'json_object' };
  return body;
}

/** 解析 Retry-After 头：数字秒或 HTTP-date，返回秒数。无法解析返回 undefined。 */
export function parseRetryAfter(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const ms = Date.parse(trimmed);
  if (!Number.isNaN(ms)) return Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  return undefined;
}

async function safeReadError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500) || res.statusText;
  } catch {
    return res.statusText;
  }
}

function mapUsage(data: OpenAIChatResponse): TranslateUsage | undefined {
  const u = data.usage;
  if (!u) return undefined;
  const usage: TranslateUsage = {};
  if (typeof u.prompt_tokens === 'number') usage.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') usage.outputTokens = u.completion_tokens;
  return Object.keys(usage).length ? usage : undefined;
}

export class OpenAIEngine implements Engine {
  readonly provider: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: OpenAIEngineOptions) {
    this.provider = opts.provider;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  get id(): string {
    return this.opts.id;
  }

  async translate(req: TranslateRequest): Promise<TranslateResponse> {
    // 用时取明文 key，不常驻；未配置 key 视为配置错误（不可重试）。
    const apiKey = await this.opts.secretStore.getSecret(this.opts.apiKeyRef);
    if (!apiKey) {
      throw new EngineError(
        `missing API key (ref=${this.opts.apiKeyRef}) for engine ${this.opts.id}`,
      );
    }

    const url = resolveChatCompletionsUrl(this.opts.baseUrl);
    const body = buildRequestBody(this.opts.model, req);

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (e) {
      // 网络错 / 超时 / abort —— 架构 5.2 视为可重试（status 缺省）。
      throw new EngineError(
        `${this.opts.provider} request failed: ${(e as Error).message}`,
      );
    }

    if (!res.ok) {
      const retryAfterSeconds = parseRetryAfter(res.headers.get('retry-after'));
      const detail = await safeReadError(res);
      throw new EngineError(`${this.opts.provider} ${res.status}: ${detail}`, {
        status: res.status,
        retryAfterSeconds,
      });
    }

    const data = (await res.json()) as OpenAIChatResponse;
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new EngineError(
        `${this.opts.provider}: response missing message content`,
        { status: res.status },
      );
    }
    return { content, usage: mapUsage(data) };
  }
}
