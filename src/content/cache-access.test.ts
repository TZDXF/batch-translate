/**
 * content 侧缓存访问测试（P1-3）：编辑译文回写缓存 / 手动重译逐出缓存。
 *
 * 核心验收：
 *  - 编辑译文后回写，二次访问（同 key 读取）命中被覆盖的值。
 *  - 重译前逐出，orchestrator 同款 key 查存 miss（强制重发）。
 *  - key 与 orchestrator（runtime-deps.syncCacheKey + protocol.promptFingerprint）完全一致。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../shared/types';
import { CacheStore } from '../background/cache';
import { syncCacheKey } from '../background/cache/sync-cache-key';
import { promptFingerprint } from '../background/batcher/protocol';
import {
  __resetCacheAccessForTests,
  evictCache,
  readCache,
  writebackCache,
} from './cache-access';

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    version: 1,
    engines: { eng_a: { id: 'eng_a', label: 'A', provider: 'openai-compatible', baseUrl: 'http://x/v1', model: 'auto', enabled: true, apiKeyRef: 'r', contextWindow: 128000, maxOutput: 4096 } },
    activeEngineId: 'eng_a',
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'basic',
    agent: { systemPrompt: '', role: '', stylePreset: 'none', glossaryIds: [], pageContextEnabled: false },
    scheduling: { maxConcurrent: 3, rps: 2, tpmLimit: 0, maxRetries: 5, itemsPerBatch: 20, batchTokenBudgetRatio: 0.7 },
    cache: { enabled: true, maxSizeMB: 100, ttlDays: 0 },
    ui: { showOriginal: true, translationStyle: 'normal', hoverOnly: false, displayMode: 'bilingual' },
    domain: { mode: 'blacklist', blacklist: [], whitelist: [] },
    shortcuts: { toggle: 'Alt+Shift+T', cycleDisplayMode: 'Alt+Shift+D', retranslate: 'Alt+Shift+R' },
  };
  return { ...base, ...overrides };
}

/** orchestrator 同款 key 推导路径（runtime-deps.makeCache.cacheKey + makeProtocol.fingerprint）。 */
function orchestratorKey(source: string, config: AppConfig): string {
  const fp = promptFingerprint({
    targetLang: config.targetLang,
    sourceLang: config.sourceLang,
    mode: config.mode,
    ...(config.mode === 'agent' ? { agent: config.agent } : {}),
  });
  return syncCacheKey(source, config.activeEngineId, fp, config.targetLang);
}

describe('content 缓存访问（编辑回写 / 重译逐出）', () => {
  beforeEach(() => {
    __resetCacheAccessForTests();
  });
  afterEach(() => {
    __resetCacheAccessForTests();
  });

  it('编辑回写：覆盖该段缓存，二次访问命中被覆盖的值', async () => {
    const config = makeConfig();
    const source = 'The quick brown fox.';

    // 预置一条「旧译文」缓存（模拟 orchestrator 之前写入）。
    const store = new CacheStore();
    const oldKey = orchestratorKey(source, config);
    await store.set({
      cacheKey: oldKey, source, translated: '旧译文',
      engineId: config.activeEngineId, promptFingerprint: promptFingerprint({ targetLang: config.targetLang, sourceLang: config.sourceLang, mode: config.mode }),
      targetLang: config.targetLang, createdAt: Date.now(), hitCount: 1,
    });

    // 用户编辑为新译文 → 回写。
    await writebackCache(source, '敏捷的棕色狐狸', config);

    // 二次访问（orchestrator 同款 key 读取）命中被覆盖的值。
    const hit = await store.get(oldKey);
    expect(hit?.translated).toBe('敏捷的棕色狐狸');

    // readCache（content 侧同款路径）也读到新值。
    expect((await readCache(source, config))?.translated).toBe('敏捷的棕色狐狸');
  });

  it('重译逐出：删除该段缓存，orchestrator 查存 miss（强制重发）', async () => {
    const config = makeConfig();
    const source = 'Hello world.';
    await writebackCache(source, '你好，世界', config);
    // 写入后命中。
    expect((await readCache(source, config))?.translated).toBe('你好，世界');

    // 重译前逐出。
    await evictCache(source, config);

    // orchestrator 同款 key 查存 → miss。
    const store = new CacheStore();
    const key = orchestratorKey(source, config);
    expect(await store.get(key)).toBeUndefined();
    expect(await readCache(source, config)).toBeUndefined();
  });

  it('key 一致性：content computeCacheKey 与 orchestrator 路径产出相同 key', async () => {
    const config = makeConfig({ mode: 'agent', agent: { systemPrompt: '自定义', role: '技术翻译', stylePreset: 'technical', glossaryIds: [], pageContextEnabled: false } });
    const source = 'Some text.';
    await writebackCache(source, '某文本', config);
    // 用 orchestrator 路径的 key 能读到 content 写入的条目。
    const store = new CacheStore();
    const key = orchestratorKey(source, config);
    expect((await store.get(key))?.translated).toBe('某文本');
  });

  it('换引擎 / 换提示词 → 指纹变 → key 变，不误命中', async () => {
    const cfgBasic = makeConfig({ mode: 'basic' });
    const cfgAgent = makeConfig({ mode: 'agent', agent: { systemPrompt: 'X', role: '', stylePreset: 'none', glossaryIds: [], pageContextEnabled: false } });
    const source = 'Same source.';
    await writebackCache(source, '基础译文', cfgBasic);
    // agent 模式指纹不同 → key 不同 → 读不到基础模式的缓存。
    expect(await readCache(source, cfgAgent)).toBeUndefined();
    expect((await readCache(source, cfgBasic))?.translated).toBe('基础译文');
  });
});
