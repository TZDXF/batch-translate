/**
 * 引擎注册表（架构 6.2 / 2.3）。
 *
 * 按 `config.engines` 实例化引擎。每个 engine 持有 secret-store 引用，
 * 在 translate 时惰性解密取明文 API Key —— 实例化阶段不触碰明文。
 *
 * provider 工厂在此分发：openai/openai-compatible 由本任务实现；
 * anthropic/gemini/ollama 接口已预留（见 adapter.ENGINE_PROVIDERS），P1 实现。
 */
import { type Engine, type EngineConfig } from './adapter';
import { OpenAIEngine } from './openai';
import type { SecretStore } from '../config/secret-store';

export interface EngineRegistry {
  /** 取引擎；不存在返回 undefined。 */
  get(id: string): Engine | undefined;
  has(id: string): boolean;
  /** 所有已实例化（enabled）引擎。 */
  list(): Engine[];
}

export interface EngineRegistryDeps {
  secretStore: SecretStore;
  /** 可注入 fetch，透传给各引擎实现（测试 mock）。 */
  fetchFn?: typeof fetch;
}

export function createEngineRegistry(
  configs: EngineConfig[],
  deps: EngineRegistryDeps,
): EngineRegistry {
  const engines = new Map<string, Engine>();
  for (const cfg of configs) {
    // enabled 缺省视为 true；显式 false 跳过。
    if (cfg.enabled === false) continue;
    if (engines.has(cfg.id)) {
      throw new Error(`duplicate engine id: ${cfg.id}`);
    }
    engines.set(cfg.id, instantiate(cfg, deps));
  }

  return {
    get: (id) => engines.get(id),
    has: (id) => engines.has(id),
    list: () => [...engines.values()],
  };
}

function instantiate(cfg: EngineConfig, deps: EngineRegistryDeps): Engine {
  switch (cfg.provider) {
    case 'openai':
    case 'openai-compatible':
      return new OpenAIEngine({
        id: cfg.id,
        label: cfg.label,
        provider: cfg.provider,
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        apiKeyRef: cfg.apiKeyRef,
        secretStore: deps.secretStore,
        fetchFn: deps.fetchFn,
      });
    case 'anthropic':
    case 'gemini':
    case 'ollama':
      // P1 范围：接口已预留，实现见后续任务（见 issue 约束「Claude/Gemini/Ollama 为 P1」）。
      throw new Error(
        `engine provider "${cfg.provider}" not implemented yet (P1) — engine "${cfg.id}"`,
      );
    default: {
      // 穷尽性兜底：未来新增 provider 必须在此显式处理。
      const _exhaustive: never = cfg.provider;
      throw new Error(`unsupported engine provider: ${String(_exhaustive)}`);
    }
  }
}
