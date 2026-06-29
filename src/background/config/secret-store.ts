/**
 * 加密密钥存储（架构 7.2）。
 *
 * 存储风险（架构 7.2）：chrome.storage.local 明文 API Key 会随 profile 备份泄露、被本地
 * 文件读取、被同 host 权限扩展读取。对策 = AES-GCM 加密后落盘。
 *
 * 主密钥来源（P0 用方案 a）：crypto.getRandomValues 生成 256-bit 主密钥，存 storage.local
 * （key = __mk）。仅混淆级，挡爬虫/同步泄露；P1 升级为主密码 PBKDF2 派生（方案 b）。
 *
 * 接口（架构 7.2.3）：setSecret/getSecret 内部加解密，调用方（引擎适配层）只拿内存明文，
 * 不落盘。明文绝不进 storage.sync（会云同步）。
 *
 * ⚠️ 注意：本文件与 P0-3/TRA-4（bt-backend）的 secret-store 职责重叠——TRA-4 计划交付同名
 * 模块但尚未合入任何分支，而 P0-11 验收「Key 加密」强依赖它，故此处先按架构 7.2 落地一份
 * 自洽实现，供 leader 在合并 P0-3 时去重协调。接口签名严格对齐架构 7.2.3。
 */
import { MASTER_KEY_STORAGE_KEY } from '../../shared/constants';

/** 单个密文的存储键前缀。 */
const SECRET_KEY_PREFIX = '__secret:';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 内存缓存的主密钥（CryptoKey 不可结构化克隆，仅内存持有）。 */
let cachedMasterKey: CryptoKey | null = null;

function secretKey(ref: string): string {
  return `${SECRET_KEY_PREFIX}${ref}`;
}

// ─── base64 编解码（Uint8Array ↔ base64，分块避免栈溢出） ───────────────────
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/** 取得（必要时生成并持久化）AES-GCM 256-bit 主密钥。方案 a。 */
async function getMasterKey(): Promise<CryptoKey> {
  if (cachedMasterKey) return cachedMasterKey;
  const rec = await chrome.storage.local.get(MASTER_KEY_STORAGE_KEY);
  const stored = rec[MASTER_KEY_STORAGE_KEY];
  let raw: Uint8Array<ArrayBuffer>;
  if (typeof stored === 'string' && stored.length > 0) {
    raw = base64ToBytes(stored);
  } else {
    raw = crypto.getRandomValues(new Uint8Array(32));
    await chrome.storage.local.set({ [MASTER_KEY_STORAGE_KEY]: bytesToBase64(raw) });
  }
  cachedMasterKey = await crypto.subtle.importKey(
    'raw',
    raw,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  return cachedMasterKey;
}

/** 生成引擎 apiKeyRef 用的稳定引用 id。 */
export function generateSecretRef(): string {
  const r = crypto.getRandomValues(new Uint8Array(8));
  return `key_${Array.from(r)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** 加密并存储明文（不落明文盘）。架构 7.2.3。 */
export async function setSecret(ref: string, plaintext: string): Promise<void> {
  const key = await getMasterKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const payload = `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipherBuf))}`;
  await chrome.storage.local.set({ [secretKey(ref)]: payload });
}

/** 取回明文；未存储返回 null。 */
export async function getSecret(ref: string): Promise<string | null> {
  const rec = await chrome.storage.local.get(secretKey(ref));
  const stored = rec[secretKey(ref)];
  if (typeof stored !== 'string') return null;
  const sep = stored.indexOf('.');
  if (sep <= 0) return null;
  const ivB64 = stored.slice(0, sep);
  const ctB64 = stored.slice(sep + 1);
  if (!ivB64 || !ctB64) return null;
  const key = await getMasterKey();
  try {
    const plainBuf = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(ivB64) },
      key,
      base64ToBytes(ctB64),
    );
    return dec.decode(plainBuf);
  } catch {
    // 主密钥轮换/数据损坏时返回 null 而非抛出，调用方按「未配置 key」处理。
    return null;
  }
}

/** 是否已配置该 ref 的密钥。 */
export async function hasSecret(ref: string): Promise<boolean> {
  const rec = await chrome.storage.local.get(secretKey(ref));
  return typeof rec[secretKey(ref)] === 'string';
}

/** 删除密钥（引擎删除/重置时调用）。 */
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
  cachedMasterKey = null;
}
