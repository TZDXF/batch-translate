/**
 * 测试用 chrome.* 内存 mock。注入到 globalThis.chrome，让 config-store / secret-store
 * 等依赖 chrome.storage / chrome.runtime 的模块可在 jsdom/node 下单测。
 *
 * 提供：storage.local 内存键值（含 onChanged 广播）、runtime.sendMessage 调用记录。
 */

export interface ChromeMock {
  chrome: unknown;
  /** 底层内存存储（local 区，测试断言用）。 */
  _store: Map<string, unknown>;
  /** 底层内存存储（session 区，测试断言用）。 */
  _sessionStore: Map<string, unknown>;
  /** 触发 storage.onChanged（模拟写盘广播）。 */
  _fireOnChanged: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, area: string) => void;
  /** 已发送的 runtime 消息记录。 */
  _sentMessages: unknown[];
  _listeners: Set<(changes: Record<string, unknown>, area: string) => void>;
}

export function createChromeMock(): ChromeMock {
  const store = new Map<string, unknown>();
  const sessionStore = new Map<string, unknown>();
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const sent: unknown[] = [];

  const fire = (
    changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
    area: string,
  ): void => {
    for (const fn of listeners) fn(changes, area);
  };

  /** 通用 KV 存储区构造：local 与 session 共用同一份 get/set/remove 语义。 */
  function makeArea(map: Map<string, unknown>, area: string) {
    async function get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      const out: Record<string, unknown> = {};
      if (keys == null) {
        for (const [k, v] of map) out[k] = v;
      } else if (typeof keys === 'string') {
        if (map.has(keys)) out[keys] = map.get(keys);
      } else {
        for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      }
      return out;
    }

    async function set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        const had = map.has(k);
        changes[k] = { oldValue: had ? map.get(k) : undefined, newValue: v };
        map.set(k, v);
      }
      fire(changes, area);
    }

    async function remove(keys: string | string[]): Promise<void> {
      const ks = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const k of ks) {
        if (map.has(k)) {
          changes[k] = { oldValue: map.get(k), newValue: undefined };
          map.delete(k);
        }
      }
      fire(changes, area);
    }

    return { get, set, remove, clear: async () => map.clear() };
  }

  const chrome = {
    storage: {
      local: makeArea(store, 'local'),
      session: makeArea(sessionStore, 'session'),
      onChanged: {
        addListener: (fn: (changes: Record<string, unknown>, area: string) => void) => listeners.add(fn),
        removeListener: (fn: (changes: Record<string, unknown>, area: string) => void) => listeners.delete(fn),
        hasListener: (fn: (changes: Record<string, unknown>, area: string) => void) => listeners.has(fn),
      },
    },
    runtime: {
      sendMessage: async (msg: unknown): Promise<undefined> => {
        sent.push(msg);
        return undefined;
      },
      id: 'test-extension',
    },
  };

  return {
    chrome,
    _store: store,
    _sessionStore: sessionStore,
    _fireOnChanged: fire,
    _sentMessages: sent,
    _listeners: listeners,
  };
}

/** 注入 chrome mock 到 globalThis，返回 mock 句柄。 */
export function installChromeMock(): ChromeMock {
  const mock = createChromeMock();
  (globalThis as { chrome?: unknown }).chrome = mock.chrome;
  return mock;
}
