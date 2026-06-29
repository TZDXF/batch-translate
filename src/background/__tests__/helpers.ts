import { vi } from 'vitest';
import type { SecretStorageArea } from '../config/storage';
import type { SecretStore } from '../config/secret-store';

/**
 * 内存版 storage.local，用于 secret-store 单元测试。
 * 额外暴露 _dump() 以便断言"存储里没有明文"。
 */
export function createMemoryStorage(): SecretStorageArea & {
  _dump(): Record<string, unknown>;
} {
  const map = new Map<string, unknown>();
  return {
    async get(keys) {
      const out: Record<string, unknown> = {};
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of keys) map.delete(k);
    },
    _dump() {
      return Object.fromEntries(map);
    },
  };
}

/** fake secret-store：getSecret 返回固定 key（或 undefined），供 engine 测试注入。 */
export function fakeSecretStore(opts: { key?: string } = {}): SecretStore {
  return {
    setSecret: vi.fn(async () => {}),
    getSecret: vi.fn(async () => opts.key),
    deleteSecret: vi.fn(async () => {}),
    secretExists: vi.fn(async () => opts.key !== undefined),
  };
}
