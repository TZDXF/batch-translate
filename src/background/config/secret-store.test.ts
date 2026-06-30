import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../../test/chrome-mock';
import {
  setSecret,
  getSecret,
  hasSecret,
  deleteSecret,
  resetSecret,
  generateSecretRef,
  __clearMasterKeyCacheForTests,
} from './secret-store';
import { MASTER_KEY_STORAGE_KEY } from '../../shared/constants';

describe('secret-store（AES-GCM 加密密钥存储，架构 7.2 方案 a）', () => {
  let mock: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mock = installChromeMock();
    __clearMasterKeyCacheForTests();
  });

  it('加解密往返：getSecret 还原 setSecret 写入的明文', async () => {
    await setSecret('key_abc', 'sk-proj-1234567890');
    expect(await getSecret('key_abc')).toBe('sk-proj-1234567890');
  });

  it('未存储的 ref 返回 null', async () => {
    expect(await getSecret('key_missing')).toBeNull();
    expect(await hasSecret('key_missing')).toBe(false);
  });

  it('storage.local 中绝不出现明文 key（仅密文 + 主密钥）', async () => {
    const plaintext = 'sk-never-plaintext-in-storage';
    await setSecret('key_x', plaintext);
    // 扫描整个内存存储，确保明文不落盘。
    for (const [, v] of mock._store) {
      expect(String(v)).not.toContain(plaintext);
    }
    // 密文键存在，主密钥键存在。
    expect(mock._store.has('__secret:key_x')).toBe(true);
    expect(mock._store.has(MASTER_KEY_STORAGE_KEY)).toBe(true);
  });

  it('主密钥仅生成一次：相同明文两次写入仍可解（主密钥复用）', async () => {
    await setSecret('k1', 'aaaa');
    const mk1 = mock._store.get(MASTER_KEY_STORAGE_KEY);
    await setSecret('k2', 'bbbb');
    const mk2 = mock._store.get(MASTER_KEY_STORAGE_KEY);
    expect(mk1).toBe(mk2); // 复用同一主密钥
    expect(await getSecret('k1')).toBe('aaaa');
    expect(await getSecret('k2')).toBe('bbbb');
  });

  it('多个 ref 互不干扰', async () => {
    await setSecret('a', 'alpha');
    await setSecret('b', 'beta');
    expect(await getSecret('a')).toBe('alpha');
    expect(await getSecret('b')).toBe('beta');
    await deleteSecret('a');
    expect(await hasSecret('a')).toBe(false);
    expect(await getSecret('b')).toBe('beta');
  });

  it('resetSecret 覆盖旧明文', async () => {
    await setSecret('r', 'old');
    await resetSecret('r', 'new');
    expect(await getSecret('r')).toBe('new');
  });

  it('generateSecretRef 生成 key_ 前缀的唯一引用 id', () => {
    const r1 = generateSecretRef();
    const r2 = generateSecretRef();
    expect(r1).toMatch(/^key_[0-9a-f]{16}$/);
    expect(r1).not.toBe(r2);
  });

  it('篡改/损坏密文返回 null 而非抛出（容错）', async () => {
    await setSecret('k', 'hello');
    // 人为破坏密文。
    mock._store.set('__secret:k', 'not.validbase64!!');
    expect(await getSecret('k')).toBeNull();
  });
});
