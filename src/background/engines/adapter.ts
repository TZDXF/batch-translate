/**
 * 引擎适配层统一接口（架构 4.4 / 7.2.3，P0-3 / TRA-4）。
 *
 * 这是「免费用 AI 智能体翻译」痛点的基础设施：所有 provider（OpenAI 兼容 / Claude /
 * Gemini / Ollama）实现同一个 `Engine` 接口，上层 orchestrator 只依赖此抽象，不感知
 * 具体厂商的请求体/鉴权/响应结构差异。
 *
 * ── 与 orchestrator 的接缝 ────────────────────────────────────────────────
 * `src/background/orchestrator.ts` 为隔离 Stage 2 自身声明了一份 `Engine` DI 接口
 * （字段：id / provider / translate）。本文件实现的 `Engine` 与之签名一一对应 ——
 * runtime-deps.ts 可把本层产出的引擎实例直接注入 orchestrator，无需薄包装。
 *
 * ── 密钥边界（架构 7.2.3） ────────────────────────────────────────────────
 * `translate` 调用方（registry）在构造引擎时注入「内存明文 key」，绝不在此处落盘，
 * 绝不进 storage.sync。本层只持有内存引用。
 *
 * ── provider 预留（架构 6.2） ─────────────────────────────────────────────
 * P0 只实现 OpenAI 兼容（adapter + openai.ts + registry）。anthropic / gemini /
 * ollama 为 P1 范围 —— 本接口设计已预留：`createEngine` 按 provider 分发，新增厂商
 * 只需在 openai.ts 旁加一个实现文件并在 factory 注册，不改 adapter 契约。
 */
import type { EngineConfig, EngineProvider } from '../../shared/types';
import { OpenAIEngine } from './openai';

/** 统一引擎接口 —— 所有 provider 实现此接口，orchestrator 只依赖它。 */
export interface Engine {
  /** 引擎实例 id（一般等于 EngineConfig.id）。 */
  id: string;
  /** provider 标识（openai / openai-compatible / anthropic / gemini / ollama）。 */
  provider: string;
  /** 执行一次翻译请求。 */
  translate(req: TranslateRequest): Promise<TranslateResponse>;
}

/** 统一翻译请求 —— 跨 provider 的最小公共集（架构 4.2 / 4.4）。 */
export interface TranslateRequest {
  /** 系统提示词（架构 4.3，基础/智能体模式）。 */
  systemPrompt: string;
  /** 用户消息（架构 4.2 items JSON 信封，由 protocol 产出，引擎原样发送）。 */
  userMessage: string;
  /** 目标语言。 */
  targetLang: string;
  /**
   * 强制结构化输出开关（架构 4.4）：OpenAI `response_format:{type:"json_object"}`、
   * Gemini `responseMimeType:"application/json"`、Claude tool use 等。适配层按引擎开启。
   */
  jsonMode: boolean;
  /** 中止信号，CANCEL 时触发；真实 fetch 会随 signal 中止（架构 5.2 AbortError 直抛）。 */
  signal?: AbortSignal;
}

/** 统一翻译响应。 */
export interface TranslateResponse {
  /** 引擎返回的正文（OpenAI choices[0].message.content 等，归一化为字符串）。 */
  content: string;
  /** token 用量（可选，供额度统计；缺失则上层不计）。 */
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** 构造引擎所需的最小上下文：引擎配置 + 内存明文 key（registry 解析后注入）。 */
export interface EngineInit {
  config: EngineConfig;
  /** 明文 API Key（内存使用，绝不落盘/不进 sync）。Ollama 本地模式可为空串。 */
  apiKey: string;
}

/**
 * 按 provider 创建引擎实例（工厂）。新增 provider：在此处加一个分支即可。
 *
 * @throws {EngineInitError} provider 不支持或配置非法。
 */
export function createEngine(init: EngineInit): Engine {
  const { config, apiKey } = init;
  switch (config.provider) {
    case 'openai':
    case 'openai-compatible':
      // OpenAI 官方与任意 OpenAI 兼容 endpoint（DeepSeek / 通用 v1）共用同一实现：
      // 同样的 /chat/completions + Bearer + response_format。
      return new OpenAIEngine(config, apiKey);
    case 'anthropic':
    case 'gemini':
    case 'ollama':
      // P1 范围（架构 8）。本任务只做 OpenAI 兼容 + adapter 接口，此处显式抛错
      // 而非静默回退，避免误用未实现引擎把请求打到错误 endpoint。
      throw new EngineInitError(
        `provider "${config.provider}" 尚未实现（P1 范围）；本任务仅交付 OpenAI 兼容`,
      );
    default:
      throw new EngineInitError(`未知 provider: ${config.provider as EngineProvider}`);
  }
}

/** 引擎构造/初始化错误（配置非法、provider 未实现、缺 key 等）。 */
export class EngineInitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineInitError';
  }
}

/** 引擎请求运行时错误（HTTP 非 2xx、网络错、响应解析失败等）。 */
export class EngineRequestError extends Error {
  /** HTTP 状态码（网络错为 0）。供 retry 层判断 429/5xx/4xx 分支（架构 5.2）。 */
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'EngineRequestError';
    this.status = status;
  }
}
