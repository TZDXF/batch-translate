/**
 * 引擎适配统一接口（架构 2.3 / 4.4）。
 *
 * 所有 LLM provider 实现 `Engine` 接口；orchestrator 只依赖此抽象，
 * 切换/新增引擎（OpenAI 兼容 / Claude / Gemini / Ollama）不改上层。
 *
 * 引擎配置 `EngineConfig` 与 provider 枚举 `EngineProvider` 复用 shared 契约
 * （TRA-3 / src/shared/types.ts），保持单一事实来源；此处仅 re-export 供
 * engine 层消费者使用。TranslateRequest / TranslateResponse 为引擎层自有契约
 * （issue P0-3 指定签名写在 adapter.ts）。
 */
export type { EngineConfig, EngineProvider } from '../../shared/types';

/** 翻译请求（provider 无关）。 */
export interface TranslateRequest {
  /** 系统提示词（含目标语言 / 角色 / 术语等约束，由 protocol/agent 层组装）。 */
  systemPrompt: string;
  /** 用户消息正文（批量协议下为 4.2 的 JSON 文本）。 */
  userMessage: string;
  /** 目标语言（已融入 systemPrompt；冗余保留供 provider 特殊处理，如 Gemini responseSchema 命名）。 */
  targetLang: string;
  /** 是否要求严格结构化输出（OpenAI response_format / Gemini responseMimeType / Claude tool use）。 */
  jsonMode: boolean;
  /** 可选中止信号（用于 cancel 整批在途请求）。 */
  signal?: AbortSignal;
}

/** token 用量（可选，用于额度保护 / 统计）。 */
export interface TranslateUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** 翻译响应。content 为模型原始输出文本（批量协议下为 JSON 文本，由 protocol 层解析）。 */
export interface TranslateResponse {
  content: string;
  usage?: TranslateUsage;
}

/**
 * 引擎统一接口。每个 provider 一个实现。
 * id 与 config.engines[id].id 对应；provider 标识类别（供 registry 工厂分发）。
 */
export interface Engine {
  readonly id: string;
  readonly provider: string;
  translate(req: TranslateRequest): Promise<TranslateResponse>;
}

/**
 * 引擎抛出的错误。携带 HTTP status 与可选 Retry-After 秒数，
 * 供调度层（P0-5 retry）判断是否重试 / 退避（架构 5.2）。
 */
export class EngineError extends Error {
  /** HTTP 状态码；网络错/超时/中止时为 undefined。 */
  readonly status?: number;
  /** Retry-After 换算的秒数（尊重服务端节流）。 */
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    options: { status?: number; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'EngineError';
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
