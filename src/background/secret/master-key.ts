/**
 * 主密钥派生与管理（架构 7.2 方案 b，TRA-22）。
 *
 * 方案 b：主密钥不再随机落盘，而是由用户主密码经 PBKDF2 派生。密码绝不落盘、绝不进
 * storage.sync；派生出的主密钥材料只在 storage.session（内存态，SW 卸载 / 浏览器关闭即
 * 失）中持有「解锁态」。SW 重启后 getMasterKey 未解锁 → 抛 LockedError，由调用方触发
 * popup 解锁流程。
 *
 * 双模兼容（迁移路径）：未设置主密码时回退方案 a（随机主密钥存 storage.local，仅混淆），
 * 存量密钥照常解密；用户首次设置主密码时，把所有 __secret:* 用旧主密钥解出、用新派生
 * 主密钥重新加密落盘，并删除旧 __mk —— 不丢用户已有 key。
 *
 * PBKDF2 参数（OWASP Password Storage Cheat Sheet 当前建议，issue 约定 ≥210000）：
 *   - 算法：PBKDF2-HMAC-SHA-512
 *   - 迭代次数：210000
 *   - salt：随机 16 字节（128bit）
 *   - 派生位数：256bit（AES-256-GCM）
 *
 * 接口边界：本模块对外暴露 getMasterKey / setupMasterPassword / unlock / lock /
 * changeMasterPassword / isMasterPasswordConfigured / isUnlocked，以及 LockedError。
 * secret-store 的 setSecret/getSecret 内部调 getMasterKey 取主密钥，接口签名不变，
 * 引擎适配层零改动（架构 7.2.3 / TRA-22 约束）。
 */
import {
  MASTER_KEY_STORAGE_KEY,
  MASTER_KEY_SALT_STORAGE_KEY,
  MASTER_KEY_SESSION_KEY,
  MASTER_KEY_VERIFIER_STORAGE_KEY,
  PBKDF2_DERIVED_BITS,
  PBKDF2_HASH_ALGO,
  PBKDF2_ITERATIONS,
  PBKDF2_SALT_LENGTH,
} from '../../shared/constants';

/** 密钥库已锁定（SW 重启后未在 popup 解锁）。调用方据此触发 popup 解锁流程。 */
export class LockedError extends Error {
  constructor(message = '密钥库已锁定，需在 popup 输入主密码解锁') {
    super(message);
    this.name = 'LockedError';
  }
}

/** 主密码校验失败（unlock/changeMasterPassword 输入密码错误）。 */
export class WrongPasswordError extends Error {
  constructor(message = '主密码错误') {
    super(message);
    this.name = 'WrongPasswordError';
  }
}

/** 校验值明文 token：用派生主密钥加密后落盘，解锁时解密比对以验证密码正确性。 */
const VERIFIER_TOKEN = 'bt-master-key-v1';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 方案 a 内存缓存的主密钥（CryptoKey 不可结构化克隆，仅内存持有）。 */
let cachedLegacyKey: CryptoKey | null = null;

// ─── base64 编解码（Uint8Array ↔ base64，分块避免栈溢出） ───────────────────
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// ─── AES-GCM 加解密（payload 格式：`ivBase64.ctBase64`） ───────────────────
/** 用主密钥加密明文，返回 `iv.ct` payload。 */
export async function aesEncrypt(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuf))}`;
}

/** 用主密钥解密 `iv.ct` payload；损坏/密钥不匹配返回 null（容错，不抛）。 */
export async function aesDecrypt(key: CryptoKey, payload: string): Promise<string | null> {
  const sep = payload.indexOf('.');
  if (sep <= 0) return null;
  const ivB64 = payload.slice(0, sep);
  const ctB64 = payload.slice(sep + 1);
  if (!ivB64 || !ctB64) return null;
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
      key,
      base64ToBytes(ctB64),
    );
    return dec.decode(plainBuf);
  } catch {
    return null;
  }
}

// ─── PBKDF2 派生 ───────────────────────────────────────────────────────────
/**
 * PBKDF2 派生主密钥材料（256bit）。同一 (password, salt) 确定性产出同一材料。
 * 返回原始字节，调用方按需 importKey；不直接返回 CryptoKey 以便存入 storage.session
 * （CryptoKey 跨上下文结构化克隆在部分版本不稳定，base64 字节更可移植）。
 */
export async function deriveKeyMaterial(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number = PBKDF2_ITERATIONS,
): Promise<Uint8Array<ArrayBuffer>> {
  // new Uint8Array(...) 拷贝出 ArrayBuffer-backed 副本，满足 Web Crypto 的 BufferSource 约束。
  const pwBytes = new Uint8Array(enc.encode(password));
  const baseKey = await crypto.subtle.importKey('raw', pwBytes, 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: PBKDF2_HASH_ALGO },
    baseKey,
    PBKDF2_DERIVED_BITS,
  );
  return new Uint8Array(bits);
}

/** 把 256bit 原始材料导入为 AES-GCM CryptoKey（不可导出）。 */
export async function importAesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// ─── 方案 a 回退（未设置主密码时） ─────────────────────────────────────────
/**
 * 取得（必要时生成并持久化）方案 a 随机主密钥。仅在未设置主密码时使用，保证存量/新装
 * 用户在设置主密码前secret-store 行为与 P0 一致（零回归）。
 */
async function getOrCreateLegacyMasterKey(): Promise<CryptoKey> {
  if (cachedLegacyKey) return cachedLegacyKey;
  const rec = await chrome.storage.local.get(MASTER_KEY_STORAGE_KEY);
  const stored = rec[MASTER_KEY_STORAGE_KEY];
  let raw: Uint8Array<ArrayBuffer>;
  if (typeof stored === 'string' && stored.length > 0) {
    raw = base64ToBytes(stored);
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await chrome.storage.local.set({ [MASTER_KEY_STORAGE_KEY]: bytesToBase64(raw) });
  }
  cachedLegacyKey = await importAesKey(raw);
  return cachedLegacyKey;
}

// ─── 解锁态 ────────────────────────────────────────────────────────────────
/** 是否已设置主密码（storage.local 有 salt + 校验值）。 */
export async function isMasterPasswordConfigured(): Promise<boolean> {
  const rec = await chrome.storage.local.get([
    MASTER_KEY_SALT_STORAGE_KEY,
    MASTER_KEY_VERIFIER_STORAGE_KEY,
  ]);
  return (
    typeof rec[MASTER_KEY_SALT_STORAGE_KEY] === 'string' &&
    typeof rec[MASTER_KEY_VERIFIER_STORAGE_KEY] === 'string'
  );
}

/** 是否处于解锁态（storage.session 有派生主密钥）。 */
export async function isUnlocked(): Promise<boolean> {
  const rec = await chrome.storage.session.get(MASTER_KEY_SESSION_KEY);
  return typeof rec[MASTER_KEY_SESSION_KEY] === 'string';
}

/** 读取解锁态派生主密钥；未解锁返回 null（不抛，供 UI 探测）。 */
async function getSessionKey(): Promise<CryptoKey | null> {
  const rec = await chrome.storage.session.get(MASTER_KEY_SESSION_KEY);
  const stored = rec[MASTER_KEY_SESSION_KEY];
  if (typeof stored !== 'string' || !stored) return null;
  return importAesKey(base64ToBytes(stored));
}

/** 把派生主密钥材料写入 storage.session（解锁态）。 */
async function setSessionKey(raw: Uint8Array): Promise<void> {
  await chrome.storage.session.set({ [MASTER_KEY_SESSION_KEY]: bytesToBase64(raw) });
}

/**
 * 取得主密钥用于加解密。
 * - 已设置主密码：必须解锁（session 有密钥），否则抛 LockedError。
 * - 未设置主密码：回退方案 a 随机主密钥（零回归）。
 */
export async function getMasterKey(): Promise<CryptoKey> {
  if (await isMasterPasswordConfigured()) {
    const key = await getSessionKey();
    if (!key) throw new LockedError();
    return key;
  }
  return getOrCreateLegacyMasterKey();
}

// ─── 迁移：把存量 __secret:* 从旧密钥重加密到新派生密钥 ────────────────────
/**
 * 枚举 storage.local 中所有 __secret:* 条目，用 oldKey 解出明文、用 newKey 重新加密落盘。
 * 迁移失败的单条（旧密钥解不出）跳过，不阻断整体（极端情况由用户重设该 key）。
 */
async function reencryptAllSecrets(oldKey: CryptoKey, newKey: CryptoKey): Promise<number> {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all).filter(([k]) => k.startsWith('__secret:'));
  for (const [k, payload] of entries) {
    if (typeof payload !== 'string') continue;
    const plaintext = await aesDecrypt(oldKey, payload);
    if (plaintext === null) continue; // 旧密钥解不出（已损坏 / 密钥不匹配），跳过
    const reencrypted = await aesEncrypt(newKey, plaintext);
    await chrome.storage.local.set({ [k]: reencrypted });
  }
  return entries.length;
}

// ─── 主密码管理 ────────────────────────────────────────────────────────────
/**
 * 首次设置主密码：生成 salt + 派生密钥 + 校验值，迁移存量方案 a 密钥，删除旧 __mk，
 * 写入解锁态。已设置主密码时抛错（用 changeMasterPassword 改密）。
 */
export async function setupMasterPassword(password: string): Promise<void> {
  if (password.length < 1) throw new Error('主密码不能为空');
  if (await isMasterPasswordConfigured()) {
    throw new Error('已设置主密码，请使用修改主密码入口');
  }
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const raw = await deriveKeyMaterial(password, salt);
  const newKey = await importAesKey(raw);

  // 校验值：用派生密钥加密固定 token，解锁时解密比对验证密码正确性。
  const verifier = await aesEncrypt(newKey, VERIFIER_TOKEN);

  // 迁移：旧方案 a 主密钥解出存量密钥 → 新派生密钥重加密。
  const legacyKey = cachedLegacyKey ?? (await tryGetLegacyKeyForMigration());
  if (legacyKey) {
    await reencryptAllSecrets(legacyKey, newKey);
    await chrome.storage.local.remove(MASTER_KEY_STORAGE_KEY);
  }
  cachedLegacyKey = null;

  await chrome.storage.local.set({
    [MASTER_KEY_SALT_STORAGE_KEY]: bytesToBase64(salt),
    [MASTER_KEY_VERIFIER_STORAGE_KEY]: verifier,
  });
  await setSessionKey(raw);
}

/** 读取并导入旧 __mk（若存在），供迁移解密用；不存在返回 null。 */
async function tryGetLegacyKeyForMigration(): Promise<CryptoKey | null> {
  const rec = await chrome.storage.local.get(MASTER_KEY_STORAGE_KEY);
  const stored = rec[MASTER_KEY_STORAGE_KEY];
  if (typeof stored !== 'string' || !stored) return null;
  return importAesKey(base64ToBytes(stored));
}

/**
 * 用主密码解锁：派生密钥 → 解密校验值比对 → 通过则写入 storage.session 解锁态。
 * 密码错误抛 WrongPasswordError；未设置主密码抛错。
 */
export async function unlock(password: string): Promise<void> {
  if (!(await isMasterPasswordConfigured())) {
    throw new Error('尚未设置主密码，无需解锁');
  }
  const rec = await chrome.storage.local.get([
    MASTER_KEY_SALT_STORAGE_KEY,
    MASTER_KEY_VERIFIER_STORAGE_KEY,
  ]);
  const saltB64 = rec[MASTER_KEY_SALT_STORAGE_KEY];
  const verifier = rec[MASTER_KEY_VERIFIER_STORAGE_KEY];
  if (typeof saltB64 !== 'string' || typeof verifier !== 'string') {
    throw new Error('主密码配置损坏');
  }
  const raw = await deriveKeyMaterial(password, base64ToBytes(saltB64));
  const key = await importAesKey(raw);
  const token = await aesDecrypt(key, verifier);
  if (token !== VERIFIER_TOKEN) {
    throw new WrongPasswordError();
  }
  await setSessionKey(raw);
}

/** 锁定：清除 storage.session 解锁态（模拟 SW 卸载 / 主动锁定）。 */
export async function lock(): Promise<void> {
  await chrome.storage.session.remove(MASTER_KEY_SESSION_KEY);
}

/**
 * 修改主密码：先用旧密码解锁（验证身份 + 取旧派生密钥），再用新 salt 派生新密钥，
 * 把所有 __secret:* 从旧密钥重加密到新密钥，更新 salt + 校验值，刷新解锁态。
 * 旧密码错误抛 WrongPasswordError。
 */
export async function changeMasterPassword(oldPassword: string, newPassword: string): Promise<void> {
  if (newPassword.length < 1) throw new Error('新主密码不能为空');
  if (!(await isMasterPasswordConfigured())) {
    throw new Error('尚未设置主密码，请先设置');
  }
  // 验证旧密码 + 取旧派生密钥材料。
  const rec = await chrome.storage.local.get([
    MASTER_KEY_SALT_STORAGE_KEY,
    MASTER_KEY_VERIFIER_STORAGE_KEY,
  ]);
  const oldSaltB64 = rec[MASTER_KEY_SALT_STORAGE_KEY];
  const oldVerifier = rec[MASTER_KEY_VERIFIER_STORAGE_KEY];
  if (typeof oldSaltB64 !== 'string' || typeof oldVerifier !== 'string') {
    throw new Error('主密码配置损坏');
  }
  const oldRaw = await deriveKeyMaterial(oldPassword, base64ToBytes(oldSaltB64));
  const oldKey = await importAesKey(oldRaw);
  if ((await aesDecrypt(oldKey, oldVerifier)) !== VERIFIER_TOKEN) {
    throw new WrongPasswordError();
  }

  // 新密码派生新密钥 + 新校验值。
  const newSalt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LENGTH));
  const newRaw = await deriveKeyMaterial(newPassword, newSalt);
  const newKey = await importAesKey(newRaw);
  const newVerifier = await aesEncrypt(newKey, VERIFIER_TOKEN);

  // 把所有存量密钥从旧密钥重加密到新密钥。
  await reencryptAllSecrets(oldKey, newKey);

  await chrome.storage.local.set({
    [MASTER_KEY_SALT_STORAGE_KEY]: bytesToBase64(newSalt),
    [MASTER_KEY_VERIFIER_STORAGE_KEY]: newVerifier,
  });
  await setSessionKey(newRaw);
}

// ─── 测试辅助 ──────────────────────────────────────────────────────────────
/** 仅供测试：清空内存方案 a 主密钥缓存（避免测试间串扰）。 */
export function __clearMasterKeyCacheForTests(): void {
  cachedLegacyKey = null;
}
