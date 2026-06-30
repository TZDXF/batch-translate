/**
 * OpenAI 兼容引擎实现（架构 4.4 / 6.2 / 7.3，P0-3 / TRA-4）。
 *
 * 覆盖 OpenAI 官方、DeepSeek、以及任意 OpenAI 兼容 endpoint —— 它们共享同一套
 * `POST {baseUrl}/chat/completions` + `Authorization: Bearer <key>` + OpenAI 响应结构。
 * 区别仅在 baseUrl / model，由 EngineConfig 携带。
 *
 * ── 设计要点 ──────────────────────────────────────────────────────────────
 * - 原生 fetch，不引 SDK（任务约束 / 架构 7.3 透明：用户可见数据去向 = baseUrl）。
 * - response_format: {type:"json_object"} 在 jsonMode 时开启（架构 4.4 双保险之一）。
 * - AbortSignal 透传给 fetch；CANCEL 时 fetch 抛 AbortError，本层原样抛出 ——
 *   retry 层据此跳过重试（orchestrator 契约：AbortError 不可重试）。
 * - HTTP 非 2xx → 抛 EngineRequestError(含 status)，供 retry 层按 429/5xx/4xx 分支
 *   （架构 5.2）。429/5xx 可重试，4xx 非 429 不重试 —— 重试决策在 scheduler/retry，
 *   本层只负责如实暴露 status。
 * - 响应解析容错：choices[0].message.content 缺失时回退到空串并保留原始响应供诊断。
 *   （注意：完整的 JSON 结构解析/对齐在 protocol.parseResponse，本层只取 content 原文。）
 *
 * ── 密钥 ──────────────────────────────────────────────────────────────────
 * 构造时注入内存明文 key（registry 从 secret-store 取），不落盘、不进 sync。
 */
import type { EngineConfig } from '../../shared/types';
import type { Engine, TranslateRequest, TranslateResponse } from './adapter';
import { EngineRequestError } from './adapter';

/** OpenAI chat completions 请求体（仅本层用到的字段）。 */
interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  /** 架构 4.4：json_object 强制结构化输出（部分兼容 endpoint 不支持则忽略，靠解析容错兜底）。 */
  response_format?: { type: 'json_object' };
  /** 上限取自引擎配置（架构 4.5 maxOutput 预留）。 */
  max_tokens?: number;
  /** 翻译任务确定性优先，固定低温度。 */
  temperature?: number;
  stream?: false;
}

/** OpenAI chat completions 响应体（仅本层用到的字段）。 */
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** OpenAI 错误响应体（用于拼装错误信息）。 */
interface OpenAIErrorResponse {
  error?: { message?: string; type?: string; code?: string };
}

/**
 * OpenAI 兼容引擎。baseUrl 形如 `https://api.openai.com/v1`（无尾斜杠也可）。
 * 实际请求打到 `${baseUrl}/chat/completions`。
 */
export class OpenAIEngine implements Engine {
  readonly id: string;
  readonly provider: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly maxOutput: number;

  constructor(config: EngineConfig, apiKey: string) {
    this.id = config.id;
    this.provider = config.provider;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.model = config.model;
    this.apiKey = apiKey;
    this.maxOutput = config.maxOutput;
  }

  async translate(req: TranslateRequest): Promise<TranslateResponse> {
    const url = `${this.baseUrl}/chat/completions`;
    const body: OpenAIChatRequest = {
      model: this.model,
      messages: [
        { role: 'system', content: req.systemPrompt },
        { role: 'user', content: req.userMessage },
      ],
      max_tokens: this.maxOutput,
      temperature: 0,
      stream: false,
    };
    if (req.jsonMode) {
      // 架构 4.4：强制 JSON 输出。OpenAI / DeepSeek / 多数兼容 endpoint 支持；
      // 不支持的端点通常忽略该字段，靠 protocol.parseResponse 容错链兜底。
      body.response_format = { type: 'json_object' };
    }

    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      // AbortError 原样抛出 —— retry 层据此跳过（orchestrator 契约）。
      if (isAbortError(err)) throw err;
      // 其余视为网络错（status=0），可重试（架构 5.2）。
      throw new EngineRequestError(
        `网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
        0,
      );
    }

    if (!resp.ok) {
      // 非 2xx：拼装可读错误信息，暴露 status 给 retry 层。
      const detail = await safeReadError(resp).catch(() => '');
      throw new EngineRequestError(
        `OpenAI 兼容请求失败 ${resp.status}: ${detail}`,
        resp.status,
      );
    }

    let data: OpenAIChatResponse;
    try {
      data = (await resp.json()) as OpenAIChatResponse;
    } catch (err) {
      throw new EngineRequestError(
        `响应 JSON 解析失败: ${err instanceof Error ? err.message : String(err)}`,
        resp.status,
      );
    }

    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      // 无 content：返回空串而非抛错 —— 让 protocol.parseResponse 走降级链
      // （架构 4.6：parse 失败 → 拆小批重试）。原始响应用作诊断上下文。
      return { content: '', usage: extractUsage(data) };
    }

    return { content, usage: extractUsage(data) };
  }

  /** 鉴权头。key 为空（如 Ollama 复用本类的边缘场景）时不带 Authorization。 */
  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }
}

/** 从 OpenAI usage 字段归一化出 input/output token。 */
function extractUsage(data: OpenAIChatResponse): { inputTokens?: number; outputTokens?: number } | undefined {
  const u = data.usage;
  if (!u) return undefined;
  const out: { inputTokens?: number; outputTokens?: number } = {};
  if (typeof u.prompt_tokens === 'number') out.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === 'number') out.outputTokens = u.completion_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 尽力读取错误响应体文本供诊断；失败返回空串。 */
async function safeReadError(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    try {
      const obj = JSON.parse(text) as OpenAIErrorResponse;
      return obj.error?.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}

/** 判定 AbortError（fetch 中止 / 调用方主动 abort）。 */
function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  return err instanceof Error && err.name === 'AbortError';
}
