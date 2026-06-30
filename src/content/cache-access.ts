/**
 * content 侧缓存访问（P1-3 交互增强）。
 *
 * 「编辑译文回写缓存 / 手动重译逐出缓存」需要在 content 侧直接操作 IndexedDB：
 *  - 回写：用户编辑译文后，覆盖该段 cache entry，使二次访问命中被覆盖的值（验收项）。
 *  - 逐出：手动重译时先删该段缓存，迫使 orchestrator 跳过缓存强制重发（batch=1 由 packer
 *    对单段自然成批），重译成功后 orchestrator 自动回写缓存。
 *
 * ★ key 一致性：缓存键必须与 orchestrator（runtime-deps）完全一致，否则回写的值不会被命中。
 * orchestrator 用 syncCacheKey(source, engineId, fingerprint, targetLang)，其中 fingerprint
 * 由 protocol.promptFingerprint 算（djb2 over system prompt）。本模块复用同一组纯函数，确保
 * key 与 SW 侧逐一对应（单一事实来源：sync-cache-key.ts + protocol.promptFingerprint）。
 *
 * 纯逻辑 + idb，无 chrome 依赖，vitest（fake-indexeddb）可直接覆盖。
 */
import type { AppConfig } from '../shared/types';
import { CacheStore, type CacheEntry } from '../background/cache';
import { syncCacheKey } from '../background/cache/sync-cache-key';
import { promptFingerprint } from '../background/batcher/protocol';

/** content 侧复用的单例 CacheStore（与 SW 共用同一 IDB 库 batchtranslate-cache）。 */
let storeSingleton: CacheStore | null = null;
function getStore(): CacheStore {
  if (!storeSingleton) storeSingleton = new CacheStore();
  return storeSingleton;
}

/** 仅供测试：重置单例（测试间隔离）。 */
export function __resetCacheAccessForTests(): void {
  storeSingleton = null;
}

/** 按当前配置计算提示词指纹（与 orchestrator buildContext 同款 PromptContext）。 */
function fingerprintOf(config: AppConfig): string {
  return promptFingerprint({
    targetLang: config.targetLang,
    sourceLang: config.sourceLang,
    mode: config.mode,
    ...(config.mode === 'agent' ? { agent: config.agent } : {}),
  });
}

/**
 * 按 orchestrator 同款契约计算缓存键。
 * fingerprint 由当前配置（目标语言 / 源语言 / 模式 / 智能体配置）决定，与 buildContext 一致。
 */
export function computeCacheKey(source: string, config: AppConfig): string {
  const fingerprint = fingerprintOf(config);
  return syncCacheKey(source, config.activeEngineId, fingerprint, config.targetLang);
}

/**
 * 回写（覆盖）一段译文缓存。
 * 复用 P0-6 cache-key 契约，不改 cache schema —— 写入完整 CacheEntry，覆盖同 key 旧值。
 * createdAt 刷新为当前时间，hitCount 归零（用户编辑后的新基准）。
 */
export async function writebackCache(
  source: string,
  translated: string,
  config: AppConfig,
): Promise<void> {
  const fingerprint = fingerprintOf(config);
  const key = syncCacheKey(source, config.activeEngineId, fingerprint, config.targetLang);
  const entry: CacheEntry = {
    cacheKey: key,
    source,
    translated,
    engineId: config.activeEngineId,
    promptFingerprint: fingerprint,
    targetLang: config.targetLang,
    createdAt: Date.now(),
    hitCount: 0,
  };
  await getStore().set(entry);
}

/**
 * 逐出一段译文缓存（手动重译前置）。
 * 删除后 orchestrator 的 cache.getMany 必然 miss 该段 → 强制重发，满足「跳过缓存」语义。
 */
export async function evictCache(source: string, config: AppConfig): Promise<void> {
  const key = computeCacheKey(source, config);
  await getStore().delete(key);
}

/** 读取一段译文缓存（测试 / 二次访问命中校验用）。 */
export async function readCache(
  source: string,
  config: AppConfig,
): Promise<CacheEntry | undefined> {
  const key = computeCacheKey(source, config);
  return getStore().get(key);
}
