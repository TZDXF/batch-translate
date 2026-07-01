/**
 * 加密密钥存储（架构 7.2）。
 *
 * 存储风险（架构 7.2）：chrome.storage.local 明文 API Key 会随 profile 备份泄露、被本地
 * 文件读取、被同 host 权限扩展读取。对策 = AES-GCM 加密后落盘。
 *
 * 主密钥来源（架构 7.2.2）：
 *   - 方案 a（P0）：随机 256-bit 主密钥存 storage.local（仅混淆）。
 *   - 方案 b（P1，TRA-22）：主密码 PBKDF2 派生主密钥，密码不落盘；解锁态存 storage.session，
 *     SW 卸载即失密。见 ./secret/master-key.ts。
 *
 * 本模块只持有「密文 ↔ 明文」的加解密与 ref 管理；主密钥的派生 / 解锁 / 迁移全部下沉到
 * master-key.ts。接口签名（setSecret/getSecret/hasSecret/deleteSecret）严格对齐架构 7.2.3，
 * 引擎适配层零改动 —— getSecret 在「已设置主密码但未解锁」时抛 LockedError，由调用方
 * （orchestrator / 引擎注册表上层）触发 popup 解锁流程；未设置主密码时回退方案 a，零回归。
 *
 * 明文绝不进 storage.sync（会云同步）。hasSecret/deleteSecret 不需主密钥，锁定态仍可用
 * （供 UI 展示「Key 已设置」徽标、删除引擎时清密钥）。
 */
import {
  aesDecrypt,
  aesEncrypt,
  __clearMasterKeyCacheForTests as clearMasterKeyCache,
  getMasterKey,
} from '../secret/master-key';

export { LockedError } from '../secret/master-key';

/** 单个密文的存储键前缀。 */
const SECRET_KEY_PREFIX = '__secret:';

function secretKey(ref: string): string {
  return `${SECRET_KEY_PREFIX}${ref}`;
}

/** 生成引擎 apiKeyRef 用的稳定引用 id。 */
export function generateSecretRef(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return `key_${Array.from(r)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 加密并存储明文（不落明文盘）。架构 7.2.3。
 * 已设置主密码但未解锁时抛 LockedError。
 */
export async function setSecret(ref: string, plaintext: string): Promise<void> {
  const key = await getMasterKey();
  const payload = await aesEncrypt(key, plaintext);
  await chrome.storage.local.set({ [secretKey(ref)]: payload });
}

/**
 * 取回明文；未存储返回 null。
 * 已设置主密码但未解锁时抛 LockedError（调用方据此触发 popup 解锁）。
 */
export async function getSecret(ref: string): Promise<string | null> {
  const rec = await chrome.storage.local.get(secretKey(ref));
  const stored = rec[secretKey(ref)];
  if (typeof stored !== 'string') return null;
  const key = await getMasterKey();
  return aesDecrypt(key, stored);
}

/** 是否已配置该 ref 的密钥（不需主密钥，锁定态可用）。 */
export async function hasSecret(ref: string): Promise<boolean> {
  const rec = await chrome.storage.local.get(secretKey(ref));
  return typeof rec[secretKey(ref)] === 'string';
}

/** 删除密钥（引擎删除/重置时调用；不需主密钥，锁定态可用）。 */
export async function deleteSecret(ref: string): Promise<void> {
  await chrome.storage.local.remove(secretKey(ref));
}

/**
 * 重置密钥：删除旧的并写入新的明文。引擎「重置 Key」入口。
 * 语义与 delete+set 一致，集中暴露便于 UI 调用。
 */
export async function resetSecret(ref: string, plaintext: string): Promise<void> {
  await setSecret(ref, plaintext);
}

/** 仅供测试：清空内存主密钥缓存（避免测试间串扰）。 */
export function __clearMasterKeyCacheForTests(): void {
  clearMasterKeyCache();
}
