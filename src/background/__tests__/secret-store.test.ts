import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSecretStore,
  isSecretEntryKey,
} from '../config/secret-store';
import { createMemoryStorage } from './helpers';

describe('secret-store', () => {
  let storage: ReturnType<typeof createMemoryStorage>;
  let store: ReturnType<typeof createSecretStore>;

  beforeEach(() => {
    storage = createMemoryStorage();
    store = createSecretStore({ storage });
  });

  it('round-trips a secret (AES-GCM encrypt -> decrypt)', async () => {
    await store.setSecret('openai-key', 'sk-secret-123');
    expect(await store.getSecret('openai-key')).toBe('sk-secret-123');
  });

  it('returns undefined for an unknown ref', async () => {
    expect(await store.getSecret('nope')).toBeUndefined();
  });

  it('does NOT persist plaintext into storage.local', async () => {
    const plaintext = 'sk-NEVER-PERSIST-PLAINTEXT-xyz';
    await store.setSecret('openai-key', plaintext);

    const dump = storage._dump();
    const serialized = JSON.stringify(dump);
    // 整个 storage 序列化里不应出现明文 —— 验收标准「storage.local 里查不到明文 key」。
    expect(serialized).not.toContain(plaintext);

    // 但主密钥条目应存在（方案 a：__mk）。
    expect(dump['__mk']).toBeDefined();
    // 密文条目应存在。
    expect(dump['__sec:openai-key']).toBeDefined();
    // 所有 secret 相关条目都应是不透明字符串、不含明文。
    for (const [k, v] of Object.entries(dump)) {
      if (isSecretEntryKey(k)) {
        expect(typeof v).toBe('string');
        expect(v).not.toContain(plaintext);
      }
    }
  });

  it('isolates secrets by ref', async () => {
    await store.setSecret('a', 'AAA');
    await store.setSecret('b', 'BBB');
    expect(await store.getSecret('a')).toBe('AAA');
    expect(await store.getSecret('b')).toBe('BBB');
  });

  it('supports delete + exists', async () => {
    await store.setSecret('a', 'AAA');
    expect(await store.secretExists('a')).toBe(true);
    await store.deleteSecret('a');
    expect(await store.secretExists('a')).toBe(false);
    expect(await store.getSecret('a')).toBeUndefined();
  });

  it('reuses a single master key across multiple setSecret calls', async () => {
    await store.setSecret('a', 'AAA');
    const mk1 = storage._dump()['__mk'];
    await store.setSecret('b', 'BBB');
    const mk2 = storage._dump()['__mk'];
    expect(mk1).toBe(mk2); // __mk 只生成一次
    expect(typeof mk1).toBe('string');
  });

  it('produces distinct ciphertext for identical plaintext (random IV)', async () => {
    await store.setSecret('a', 'same');
    const c1 = storage._dump()['__sec:a'];
    await store.setSecret('a', 'same');
    const c2 = storage._dump()['__sec:a'];
    expect(c1).not.toBe(c2); // IV 随机 → 密文不同
    expect(await store.getSecret('a')).toBe('same'); // 仍正确解密
  });

  it('returns undefined when an entry is corrupted', async () => {
    await store.setSecret('a', 'AAA');
    // 篡改密文条目为非法 base64
    await storage.set({ '__sec:a': '!!!not-valid!!!' });
    expect(await store.getSecret('a')).toBeUndefined();
  });

  it('survives a fresh store instance over the same storage (key persistence)', async () => {
    await store.setSecret('a', 'AAA');
    const store2 = createSecretStore({ storage });
    expect(await store2.getSecret('a')).toBe('AAA');
  });

  it('throws when no storage backend is available', () => {
    // 临时移除全局 chrome（若存在），强制无后端
    const g = globalThis as { chrome?: unknown };
    const saved = g.chrome;
    delete g.chrome;
    try {
      expect(() => createSecretStore()).toThrow(/no storage backend/);
    } finally {
      if (saved !== undefined) g.chrome = saved;
    }
  });
});
