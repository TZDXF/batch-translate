import { describe, it, expect, beforeEach } from 'vitest';
import { cacheKey } from './cache-key';
import { CacheStore, type CacheEntry } from './cache-store';

const DAY = 24 * 60 * 60 * 1000;

function makeEntry(
  overrides: Partial<CacheEntry> & { cacheKey: string },
): CacheEntry {
  return {
    source: 'Hello',
    translated: '你好',
    engineId: 'openai',
    promptFingerprint: 'fp-v1',
    targetLang: 'zh',
    createdAt: 1_000_000,
    hitCount: 0,
    ...overrides,
  };
}

describe('cacheKey', () => {
  it('确定性: 同输入同输出, 且为 64 位 hex', async () => {
    const a = await cacheKey('hi', 'openai', 'fp1', 'zh');
    const b = await cacheKey('hi', 'openai', 'fp1', 'zh');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('任一字段变化则 key 不同', async () => {
    const base = await cacheKey('hi', 'openai', 'fp1', 'zh');
    expect(await cacheKey('hi2', 'openai', 'fp1', 'zh')).not.toBe(base);
    expect(await cacheKey('hi', 'claude', 'fp1', 'zh')).not.toBe(base);
    expect(await cacheKey('hi', 'openai', 'fp2', 'zh')).not.toBe(base);
    expect(await cacheKey('hi', 'openai', 'fp1', 'en')).not.toBe(base);
  });

  it('字段拼接歧义防护 (NUL 分隔): "a"+"bc" !== "ab"+"c"', async () => {
    const a = await cacheKey('a', 'bc', 'fp', 'zh');
    const b = await cacheKey('ab', 'c', 'fp', 'zh');
    expect(a).not.toBe(b);
  });
});

describe('CacheStore — 增删查', () => {
  let store: CacheStore;

  beforeEach(async () => {
    store = new CacheStore();
    await store.clear();
    await store.resetStats();
  });

  it('未命中返回 undefined', async () => {
    expect(await store.get('nope')).toBeUndefined();
  });

  it('set 后命中, 返回译文', async () => {
    await store.set(makeEntry({ cacheKey: 'k1', translated: '你好' }));
    const got = await store.get('k1');
    expect(got?.translated).toBe('你好');
    expect(got?.engineId).toBe('openai');
  });

  it('delete 后未命中', async () => {
    await store.set(makeEntry({ cacheKey: 'k1' }));
    await store.delete('k1');
    expect(await store.get('k1')).toBeUndefined();
  });

  it('clear 清空全部条目', async () => {
    await store.set(makeEntry({ cacheKey: 'k1' }));
    await store.set(makeEntry({ cacheKey: 'k2' }));
    await store.clear();
    expect(await store.get('k1')).toBeUndefined();
    expect(await store.get('k2')).toBeUndefined();
  });
});

describe('CacheStore — LRU 淘汰', () => {
  beforeEach(async () => {
    // 复用同一 in-memory DB, 先清空
    const cleaner = new CacheStore();
    await cleaner.clear();
    await cleaner.resetStats();
  });

  it('超容量按 createdAt 淘汰最旧条目', async () => {
    const maxSizeBytes = 1000;
    const store = new CacheStore({
      maxSizeMB: maxSizeBytes / (1024 * 1024),
    });
    const payload = 'a'.repeat(200);
    const mk = (cacheKey: string, createdAt: number) =>
      makeEntry({
        cacheKey,
        source: payload,
        translated: payload,
        createdAt,
      });

    // 每条约 479 字节 (text 400 + meta 15 + 开销 64); 三条 (~1437B) 超 1000B 上限,
    // 淘汰 createdAt 最旧的 k1, 保留 k2/k3
    await store.set(mk('k1', 1000));
    await store.set(mk('k2', 2000));
    await store.set(mk('k3', 3000));

    expect(await store.get('k1')).toBeUndefined();
    expect((await store.get('k2'))?.source).toBe(payload);
    expect(await store.get('k3')).toBeDefined();
  });

  it('未超容量不淘汰', async () => {
    const store = new CacheStore({ maxSizeMB: 10 });
    await store.set(makeEntry({ cacheKey: 'k1', createdAt: 1000 }));
    await store.set(makeEntry({ cacheKey: 'k2', createdAt: 2000 }));
    expect(await store.get('k1')).toBeDefined();
    expect(await store.get('k2')).toBeDefined();
  });
});

describe('CacheStore — TTL 过期', () => {
  beforeEach(async () => {
    const cleaner = new CacheStore();
    await cleaner.clear();
    await cleaner.resetStats();
  });

  it('未过期条目正常命中', async () => {
    const store = new CacheStore({ ttlDays: 1 });
    await store.set(makeEntry({ cacheKey: 'k1', createdAt: Date.now() }));
    const got = await store.get('k1');
    expect(got).toBeDefined();
    expect(got?.translated).toBe('你好');
  });

  it('过期条目 get 返回 undefined 并被删除', async () => {
    const store = new CacheStore({ ttlDays: 1 });
    // createdAt 落在 2 天前, 超过 1 天 TTL
    await store.set(makeEntry({ cacheKey: 'k1', createdAt: Date.now() - 2 * DAY }));
    expect(await store.get('k1')).toBeUndefined();
    // 已删除: 再次 get 依然未命中
    expect(await store.get('k1')).toBeUndefined();
  });
});

describe('CacheStore — getMany 批量', () => {
  let store: CacheStore;

  beforeEach(async () => {
    store = new CacheStore();
    await store.clear();
    await store.resetStats();
  });

  it('保持入参顺序, 命中/未命中混合', async () => {
    await store.set(makeEntry({ cacheKey: 'k1', translated: '一' }));
    await store.set(makeEntry({ cacheKey: 'k3', translated: '三' }));

    const [r1, r2, r3] = await store.getMany(['k1', 'k2', 'k3']);
    expect(r1?.translated).toBe('一');
    expect(r2).toBeUndefined();
    expect(r3?.translated).toBe('三');
  });

  it('空数组返回空', async () => {
    expect(await store.getMany([])).toEqual([]);
  });

  it('批量统计: requestCount += key 数, cacheHits += 命中数', async () => {
    await store.set(makeEntry({ cacheKey: 'k1' }));
    await store.set(makeEntry({ cacheKey: 'k3' }));
    await store.getMany(['k1', 'k2', 'k3']);
    const stats = await store.getStats();
    expect(stats.requestCount).toBe(3);
    expect(stats.cacheHits).toBe(2);
  });
});

describe('CacheStore — stats 累加', () => {
  let store: CacheStore;

  beforeEach(async () => {
    store = new CacheStore();
    await store.clear();
    await store.resetStats();
  });

  it('requestCount / cacheHits / hitCount 随命中累加', async () => {
    await store.set(makeEntry({ cacheKey: 'k1' }));
    await store.get('miss'); // 未命中: requestCount+1
    const h1 = await store.get('k1'); // 命中: hitCount 0->1
    const h2 = await store.get('k1'); // 命中: hitCount 1->2
    expect(h1?.hitCount).toBe(1);
    expect(h2?.hitCount).toBe(2);

    const stats = await store.getStats();
    expect(stats.requestCount).toBe(3);
    expect(stats.cacheHits).toBe(2);
  });

  it('addTokensUsed 累加 tokenUsed', async () => {
    await store.addTokensUsed(120);
    await store.addTokensUsed(80);
    expect((await store.getStats()).tokenUsed).toBe(200);
  });

  it('resetStats 清零', async () => {
    await store.set(makeEntry({ cacheKey: 'k1' }));
    await store.get('k1');
    await store.addTokensUsed(50);
    await store.resetStats();
    const stats = await store.getStats();
    expect(stats.requestCount).toBe(0);
    expect(stats.cacheHits).toBe(0);
    expect(stats.tokenUsed).toBe(0);
  });
});
