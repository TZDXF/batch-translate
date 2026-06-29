/**
 * IndexedDB 翻译缓存 (idb 封装)。严格遵循 ARCHITECTURE 6.1。
 *
 * DB: batchtranslate-cache
 *   - translations store: keyPath = cacheKey, indexes = [createdAt], [engineId]
 *       value: {@link CacheEntry}
 *   - meta store: out-of-line key "stats" -> {@link CacheStats}
 *
 * 行为:
 *   - LRU 淘汰:估算总字节数超 maxSizeMB 时,按 createdAt 升序删除最旧条目。
 *   - TTL:可配 (默认 0 = 永久);get 时检查过期,过期则删除并视为未命中。
 *   - 命中时 entry.hitCount 自增,并累加 meta.stats (requestCount / cacheHits)。
 *   - tokenUsed 由 orchestrator 在未命中真实翻译后经 addTokensUsed 显式累加
 *     (缓存层不知 token,解耦)。
 *
 * 纯本地、无后端、无遥测。sourceUrl 仅本地存储,绝不外传或生成分享链接 (隐私根因)。
 */

import {
  openDB,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from 'idb';

const DB_NAME = 'batchtranslate-cache';
const DB_VERSION = 1;
const STORE_TRANSLATIONS = 'translations';
const STORE_META = 'meta';
const META_STATS_KEY = 'stats';

const DEFAULT_MAX_SIZE_MB = 100;
const DEFAULT_TTL_DAYS = 0; // 0 = 永久
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/** 缓存条目,对应 ARCHITECTURE 6.1 translations store value。 */
export interface CacheEntry {
  cacheKey: string;
  source: string;
  translated: string;
  engineId: string;
  promptFingerprint: string;
  targetLang: string;
  createdAt: number;
  hitCount: number;
  /** 可选,仅本地显示,不外传。 */
  sourceUrl?: string;
}

/** 全局统计 (meta store)。 */
export interface CacheStats {
  requestCount: number;
  tokenUsed: number;
  cacheHits: number;
}

export interface CacheStoreOptions {
  /** 容量上限 (MB),超限按 createdAt LRU 淘汰。默认 100。支持小数,便于测试。 */
  maxSizeMB?: number;
  /** TTL (天),0 = 永久。默认 0。 */
  ttlDays?: number;
}

const DEFAULT_STATS: CacheStats = {
  requestCount: 0,
  tokenUsed: 0,
  cacheHits: 0,
};

/** idb 类型化 schema。 */
interface CacheDB extends DBSchema {
  translations: {
    key: string;
    value: CacheEntry;
    indexes: { createdAt: number; engineId: string };
  };
  meta: {
    key: string;
    value: CacheStats;
  };
}

type StoresTxn = IDBPTransaction<CacheDB, StoreNames<CacheDB>[], 'readwrite'>;

const sizeEncoder = new TextEncoder();

/** 估算单条缓存占用字节数 (UTF-8 文本 + 元字段 + 固定开销)。 */
function estimateBytes(entry: CacheEntry): number {
  const textBytes =
    sizeEncoder.encode(entry.source).length +
    sizeEncoder.encode(entry.translated).length;
  const metaBytes =
    entry.cacheKey.length +
    entry.engineId.length +
    entry.promptFingerprint.length +
    entry.targetLang.length;
  // 64: createdAt/hitCount 数值字段、对象头、索引等固定开销
  return textBytes + metaBytes + 64;
}

export class CacheStore {
  private readonly dbPromise: Promise<IDBPDatabase<CacheDB>>;
  private readonly maxSizeBytes: number;
  private readonly ttlMs: number; // 0 = 不过期

  constructor(options: CacheStoreOptions = {}) {
    const maxSizeMB = options.maxSizeMB ?? DEFAULT_MAX_SIZE_MB;
    this.maxSizeBytes = Math.max(0, maxSizeMB * MB);

    const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
    this.ttlMs = ttlDays > 0 ? ttlDays * DAY : 0;

    this.dbPromise = openDB<CacheDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_TRANSLATIONS)) {
          const translations = db.createObjectStore(STORE_TRANSLATIONS, {
            keyPath: 'cacheKey',
          });
          translations.createIndex('createdAt', 'createdAt');
          translations.createIndex('engineId', 'engineId');
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META);
        }
      },
    });
  }

  /**
   * 读取并 (命中时) 更新命中计数。
   * requestCount 每次调用 +1;命中时 cacheHits +1 且 entry.hitCount +1。
   * TTL 过期或未命中返回 undefined。
   */
  async get(key: string): Promise<CacheEntry | undefined> {
    const db = await this.dbPromise;
    const tx = db.transaction([STORE_TRANSLATIONS, STORE_META], 'readwrite');
    const result = await this.readAndBump(tx, key);
    await tx.done;
    return result;
  }

  /**
   * 批量读取,保持入参顺序;命中项同样更新计数。
   * 单事务内顺序处理 —— 不并发 readAndBump,避免 stats 的 read-modify-write
   * 在同事务内竞态丢更新 (符合 idb 事务“顺序请求”模型)。
   */
  async getMany(keys: string[]): Promise<(CacheEntry | undefined)[]> {
    if (keys.length === 0) return [];
    const db = await this.dbPromise;
    const tx = db.transaction([STORE_TRANSLATIONS, STORE_META], 'readwrite');
    const results: (CacheEntry | undefined)[] = [];
    for (const key of keys) {
      results.push(await this.readAndBump(tx, key));
    }
    await tx.done;
    return results;
  }

  /** 写入/覆盖一条缓存;写入后按需 LRU 淘汰。 */
  async set(entry: CacheEntry): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORE_TRANSLATIONS, entry);
    await this.evictIfNeeded();
  }

  async delete(key: string): Promise<void> {
    const db = await this.dbPromise;
    await db.delete(STORE_TRANSLATIONS, key);
  }

  /** 清空全部缓存条目 (保留统计)。 */
  async clear(): Promise<void> {
    const db = await this.dbPromise;
    await db.clear(STORE_TRANSLATIONS);
  }

  /** 当前统计快照 (缺失则返回零值)。 */
  async getStats(): Promise<CacheStats> {
    const db = await this.dbPromise;
    const stats = await db.get(STORE_META, META_STATS_KEY);
    return stats ? { ...DEFAULT_STATS, ...stats } : { ...DEFAULT_STATS };
  }

  /** 累加实际消耗 token (由 orchestrator 在未命中真实翻译后调用)。 */
  async addTokensUsed(tokens: number): Promise<void> {
    if (tokens <= 0) return;
    const db = await this.dbPromise;
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.store;
    const stats = (await store.get(META_STATS_KEY)) ?? { ...DEFAULT_STATS };
    stats.tokenUsed += tokens;
    await store.put(stats, META_STATS_KEY);
    await tx.done;
  }

  /** 清零统计 (用户重置统计用)。 */
  async resetStats(): Promise<void> {
    const db = await this.dbPromise;
    await db.put(STORE_META, { ...DEFAULT_STATS }, META_STATS_KEY);
  }

  /** 当前缓存估算总字节数 (观测/测试用)。 */
  async computeSizeBytes(): Promise<number> {
    const db = await this.dbPromise;
    let total = 0;
    let cursor = await db.transaction(STORE_TRANSLATIONS).store.openCursor();
    while (cursor) {
      total += estimateBytes(cursor.value);
      cursor = await cursor.continue();
    }
    return total;
  }

  private isExpired(createdAt: number): boolean {
    return this.ttlMs > 0 && Date.now() - createdAt > this.ttlMs;
  }

  /** 单事务内的读 + 命中计数更新,get / getMany 共用。 */
  private async readAndBump(
    tx: StoresTxn,
    key: string,
  ): Promise<CacheEntry | undefined> {
    await this.bumpStat(tx, 'requestCount', 1);
    const entry = await tx.objectStore(STORE_TRANSLATIONS).get(key);
    if (!entry) return undefined;

    if (this.isExpired(entry.createdAt)) {
      await tx.objectStore(STORE_TRANSLATIONS).delete(key);
      return undefined;
    }

    const updated: CacheEntry = { ...entry, hitCount: entry.hitCount + 1 };
    await tx.objectStore(STORE_TRANSLATIONS).put(updated);
    await this.bumpStat(tx, 'cacheHits', 1);
    return updated;
  }

  /** 事务内对 meta.stats 的某字段做原子累加。 */
  private async bumpStat(
    tx: StoresTxn,
    field: keyof CacheStats,
    delta: number,
  ): Promise<void> {
    const store = tx.objectStore(STORE_META);
    const stats = (await store.get(META_STATS_KEY)) ?? { ...DEFAULT_STATS };
    stats[field] += delta;
    await store.put(stats, META_STATS_KEY);
  }

  /** 超容量时按 createdAt 升序删除最旧条目,直至总字节 ≤ 上限。 */
  private async evictIfNeeded(): Promise<void> {
    if (this.maxSizeBytes <= 0) return;

    const total = await this.computeSizeBytes();
    if (total <= this.maxSizeBytes) return;

    const db = await this.dbPromise;
    const tx = db.transaction(STORE_TRANSLATIONS, 'readwrite');
    let cursor = await tx.store.index('createdAt').openCursor();
    let remaining = total;
    while (cursor && remaining > this.maxSizeBytes) {
      remaining -= estimateBytes(cursor.value);
      await cursor.delete();
      cursor = await cursor.continue();
    }
    await tx.done;
  }
}
