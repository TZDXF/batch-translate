/**
 * 引擎注册表（架构 6.2 / 7.2.3，P0-3 / TRA-4）。
 *
 * 按 config.engines[id] 实例化引擎，解析 `apiKeyRef` 取明文 key（经 secret-store
 * AES-GCM 解密，仅内存使用）。orchestrator 经 runtime-deps 调用 `get(engineId)` 拿到
 * 一个就绪的 `Engine` 实例，再注入 TranslateContext。
 *
 * ── 密钥解析边界（架构 7.2.3） ────────────────────────────────────────────
 * 明文 key 只在本函数返回值的内存中短暂存活（构造引擎时注入 OpenAIEngine，发完请求即
 * 随实例回收）。绝不落盘、绝不进 storage.sync、绝不随请求外发到非用户配置 endpoint。
 *
 * ── 无缓存 ────────────────────────────────────────────────────────────────
 * 每次重新读 config + secret —— config 是用户可热改的（options 保存即广播 CONFIG_CHANGED），
 * 缓存引擎实例会用到过期配置/旧 key。SW 调用频率受 scheduler 限流，多一次 storage.local
 * 读取可接受，换来配置热生效的正确性。
 */
import type { EngineConfig } from '../../shared/types';
import type { Engine } from './adapter';
import { createEngine, EngineInitError } from './adapter';
import { loadConfig } from '../config/config-store';
import { getSecret } from '../config/secret-store';

/** 需要明文 API Key 才能鉴权的 provider（Ollama 本地模式不需要）。 */
const PROVIDERS_REQUIRING_KEY = new Set(['openai', 'openai-compatible', 'anthropic', 'gemini']);

export interface EngineRegistry {
  /** 按引擎 id 解析并构造引擎实例。 */
  get(engineId: string): Promise<Engine>;
}

/**
 * 创建引擎注册表。每次 get 都重新读取最新配置 + 解密 key。
 */
export function createEngineRegistry(): EngineRegistry {
  return {
    async get(engineId: string): Promise<Engine> {
      const config = await loadConfig();
      const engineCfg = config.engines[engineId];
      if (!engineCfg) {
        throw new EngineInitError(`引擎不存在: ${engineId}`);
      }
      if (!engineCfg.enabled) {
        throw new EngineInitError(`引擎已禁用: ${engineId}`);
      }
      const apiKey = await resolveApiKey(engineCfg);
      return createEngine({ config: engineCfg, apiKey });
    },
  };
}

/**
 * 解析引擎明文 key。
 * - 需 key 的 provider：apiKeyRef 必须存在且 secret-store 能解出明文，否则抛错。
 * - Ollama：本地无需 key，返回空串。
 */
async function resolveApiKey(engineCfg: EngineConfig): Promise<string> {
  if (!PROVIDERS_REQUIRING_KEY.has(engineCfg.provider)) {
    return '';
  }
  if (!engineCfg.apiKeyRef) {
    throw new EngineInitError(`引擎 ${engineCfg.label} 未配置 API Key 引用`);
  }
  const plaintext = await getSecret(engineCfg.apiKeyRef);
  if (plaintext === null) {
    throw new EngineInitError(
      `引擎 ${engineCfg.label} 的 API Key 未存储或主密钥已变更（secret-store 解密失败）`,
    );
  }
  return plaintext;
}
