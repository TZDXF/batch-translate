/**
 * master-key 单测（架构 7.2 方案 b，TRA-22）。
 *
 * 覆盖：PBKDF2 派生确定性 / salt 随机性 / 解锁-锁定态 getSecret 行为 /
 * 存量方案 a 密钥迁移 / 改密保留密钥 / 错误密码拒绝。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../../test/chrome-mock';
import {
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_LENGTH,
  MASTER_KEY_STORAGE_KEY,
  MASTER_KEY_SALT_STORAGE_KEY,
  MASTER_KEY_SESSION_KEY,
  MASTER_KEY_VERIFIER_STORAGE_KEY,
} from '../../shared/constants';
import {
  deriveKeyMaterial,
  setupMasterPassword,
  unlock,
  lock,
  changeMasterPassword,
  isMasterPasswordConfigured,
  isUnlocked,
  WrongPasswordError,
  __clearMasterKeyCacheForTests,
} from './master-key';
import { setSecret, getSecret, LockedError } from '../config/secret-store';

describe('master-key（方案 b：PBKDF2 主密码派生）', () => {
  let mock: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mock = installChromeMock();
    __clearMasterKeyCacheForTests();
  });

  // ─── PBKDF2 派生确定性 ────────────────────────────────────────────────────
  it('PBKDF2 派生确定性：同 (password, salt) 产出同密钥材料', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
    const a = await deriveKeyMaterial('hunter2', salt);
    const b = await deriveKeyMaterial('hunter2', salt);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('PBKDF2 派生区分：不同密码产出不同密钥材料', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
    const a = await deriveKeyMaterial('hunter2', salt);
    const b = await deriveKeyMaterial('hunter3', salt);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('PBKDF2 迭代次数 = OWASP 建议（SHA-512 ≥ 210000）', () => {
    expect(PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(210_000);
    expect(PBKDF2_SALT_LENGTH).toBeGreaterThanOrEqual(16);
  });

  // ─── salt 随机性 ──────────────────────────────────────────────────────────
  it('两次设置主密码生成不同 salt（随机性）', async () => {
    await setupMasterPassword('pw-1');
    const salt1 = mock._store.get(MASTER_KEY_SALT_STORAGE_KEY);
    // 重置：改密以生成新 salt。
    await changeMasterPassword('pw-1', 'pw-2');
    const salt2 = mock._store.get(MASTER_KEY_SALT_STORAGE_KEY);
    expect(salt1).not.toBe(salt2);
  });

  // ─── 解锁 / 锁定态 getSecret 行为 ─────────────────────────────────────────
  it('设置主密码后：锁定态 getSecret 抛 LockedError', async () => {
    await setupMasterPassword('pw');
    // 解锁态下先存入密钥，再锁定模拟 SW 卸载。
    await setSecret('k', 'sk-real');
    await lock();
    expect(await isUnlocked()).toBe(false);
    // 已存储的 ref：锁定态 getSecret 抛 LockedError（调用方据此触发 popup 解锁）。
    await expect(getSecret('k')).rejects.toBeInstanceOf(LockedError);
    // setSecret 在锁定态也抛（无法加密）。
    await expect(setSecret('k2', 'sk')).rejects.toBeInstanceOf(LockedError);
  });

  it('锁定态后 unlock 输入正确密码恢复 getSecret', async () => {
    await setupMasterPassword('pw');
    await setSecret('k', 'sk-real');
    await lock();
    await expect(getSecret('k')).rejects.toBeInstanceOf(LockedError);

    await unlock('pw');
    expect(await isUnlocked()).toBe(true);
    expect(await getSecret('k')).toBe('sk-real');
  });

  it('unlock 错误密码抛 WrongPasswordError 且不解锁', async () => {
    await setupMasterPassword('pw');
    await lock();
    await expect(unlock('wrong')).rejects.toBeInstanceOf(WrongPasswordError);
    expect(await isUnlocked()).toBe(false);
  });

  it('未设置主密码时 getSecret 走方案 a 回退，不抛 LockedError（零回归）', async () => {
    expect(await isMasterPasswordConfigured()).toBe(false);
    await setSecret('k', 'sk-a');
    expect(await getSecret('k')).toBe('sk-a');
  });

  // ─── 迁移路径 ─────────────────────────────────────────────────────────────
  it('迁移：存量方案 a 密钥在设置主密码后仍可解，旧 __mk 删除', async () => {
    // 方案 a 阶段：未设主密码，写入两条密钥。
    await setSecret('a', 'sk-aaa');
    await setSecret('b', 'sk-bbb');
    const legacyMk = mock._store.get(MASTER_KEY_STORAGE_KEY);
    expect(typeof legacyMk).toBe('string');

    // 设置主密码触发迁移。
    await setupMasterPassword('pw');

    // 旧随机主密钥已删除，salt + 校验值已写入。
    expect(mock._store.has(MASTER_KEY_STORAGE_KEY)).toBe(false);
    expect(mock._store.has(MASTER_KEY_SALT_STORAGE_KEY)).toBe(true);
    expect(mock._store.has(MASTER_KEY_VERIFIER_STORAGE_KEY)).toBe(true);

    // 存量密钥仍可解出明文（不丢 key）。
    expect(await getSecret('a')).toBe('sk-aaa');
    expect(await getSecret('b')).toBe('sk-bbb');

    // 锁定后需解锁才能再读。
    await lock();
    await expect(getSecret('a')).rejects.toBeInstanceOf(LockedError);
    await unlock('pw');
    expect(await getSecret('a')).toBe('sk-aaa');
  });

  it('迁移后明文仍不落盘（storage.local 无明文）', async () => {
    const plaintext = 'sk-never-plaintext-after-migrate';
    await setSecret('a', plaintext);
    await setupMasterPassword('pw');
    for (const [, v] of mock._store) {
      expect(String(v)).not.toContain(plaintext);
    }
  });

  // ─── 改密保留密钥 ─────────────────────────────────────────────────────────
  it('changeMasterPassword：旧密码错误抛 WrongPasswordError，密钥不变', async () => {
    await setupMasterPassword('pw');
    await setSecret('k', 'sk-real');
    await expect(changeMasterPassword('wrong', 'newpw')).rejects.toBeInstanceOf(WrongPasswordError);
    // 旧密码仍可解锁，密钥仍在。
    await lock();
    await unlock('pw');
    expect(await getSecret('k')).toBe('sk-real');
  });

  it('changeMasterPassword：正确旧密码后新密码接管，密钥保留', async () => {
    await setupMasterPassword('pw');
    await setSecret('k', 'sk-real');
    await changeMasterPassword('pw', 'newpw');
    // 改密后解锁态已刷新为新密钥。
    expect(await getSecret('k')).toBe('sk-real');
    // 锁定后旧密码失效、新密码生效。
    await lock();
    await expect(unlock('pw')).rejects.toBeInstanceOf(WrongPasswordError);
    await unlock('newpw');
    expect(await getSecret('k')).toBe('sk-real');
  });

  // ─── 解锁态内存语义 ───────────────────────────────────────────────────────
  it('解锁态存 storage.session（内存），不落 storage.local', async () => {
    await setupMasterPassword('pw');
    expect(mock._sessionStore.has(MASTER_KEY_SESSION_KEY)).toBe(true);
    expect(mock._store.has(MASTER_KEY_SESSION_KEY)).toBe(false);
    await lock();
    expect(mock._sessionStore.has(MASTER_KEY_SESSION_KEY)).toBe(false);
  });
});
