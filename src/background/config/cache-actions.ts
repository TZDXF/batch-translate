/**
 * 缓存管理动作（一键清空 / 查看 stats）—— 任务交付物「缓存管理」。
 *
 * 仅按共享常量（DB/store 名）对 IndexedDB 做只读统计与清空，不重复定义 schema。
 * ⚠️ 与 P0-6/TRA-7（bt-backend）的 cache-store 职责相邻：P0-6 拥有 schema 与读写实现；
 * 此处只在 DB 已存在时操作，绝不创建空 DB（避免干扰 P0-6 的 upgrade 流程）。P0-6 合入后
 * 可改由其导出的 clear()/getStats() 提供更丰富的统计。
 */
import {
  CACHE_DB_NAME,
  CACHE_STORE_META,
  CACHE_STORE_TRANSLATIONS,
} from '../../shared/constants';

export interface CacheStats {
  requestCount: number;
  tokenUsed: number;
  cacheHits: number;
  entryCount: number;
}

function emptyStats(): CacheStats {
  return { requestCount: 0, tokenUsed: 0, cacheHits: 0, entryCount: 0 };
}

/** 仅当 DB 已存在时打开；不存在则返回 null（不触发 upgrade，不创建空 DB）。 */
function openExisting(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const req = indexedDB.open(CACHE_DB_NAME);
    let existed = true;
    req.onupgradeneeded = () => {
      existed = false;
      try {
        req.transaction?.abort();
      } catch {
        /* noop */
      }
    };
    req.onsuccess = () => {
      if (existed) resolve(req.result);
      else {
        try {
          req.result.close();
        } catch {
          /* noop */
        }
        resolve(null);
      }
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getCacheStats(): Promise<CacheStats> {
  const db = await openExisting();
  if (!db) return emptyStats();
  try {
    if (!db.objectStoreNames.contains(CACHE_STORE_TRANSLATIONS)) return emptyStats();
    const tx = db.transaction([CACHE_STORE_TRANSLATIONS, CACHE_STORE_META], 'readonly');
    const entryCount = await wrap(tx.objectStore(CACHE_STORE_TRANSLATIONS).count());
    const metaStore = tx.objectStore(CACHE_STORE_META);
    const meta = db.objectStoreNames.contains(CACHE_STORE_META)
      ? ((await wrap(metaStore.get('stats'))) as Partial<CacheStats> | undefined)
      : undefined;
    return {
      requestCount: meta?.requestCount ?? 0,
      tokenUsed: meta?.tokenUsed ?? 0,
      cacheHits: meta?.cacheHits ?? 0,
      entryCount,
    };
  } catch {
    return emptyStats();
  } finally {
    db.close();
  }
}

export async function clearCache(): Promise<void> {
  const db = await openExisting();
  if (!db) return;
  try {
    if (!db.objectStoreNames.contains(CACHE_STORE_TRANSLATIONS)) return;
    const tx = db.transaction(CACHE_STORE_TRANSLATIONS, 'readwrite');
    await wrap(tx.objectStore(CACHE_STORE_TRANSLATIONS).clear());
  } catch {
    /* noop */
  } finally {
    db.close();
  }
}
