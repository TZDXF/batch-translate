/**
 * 加密密钥存储（架构 7.2 / 4.4）。
 *
 * 用途：把用户的 LLM API Key 经 Web Crypto `AES-GCM` 加密后存入 `storage.local`，
 * 引擎适配层只拿明文在内存中使用，不落盘。
 *
 * 主密钥方案 a（P0）：`crypto.getRandomValues` 生成 256-bit 主密钥，base64 存
 * `storage.local`（key: `__mk`）。仅混淆挡爬虫/同步泄露，挡不住本地攻击者；
 * 用户密码 PBKDF2 派生方案 b 在 P1 实现（见架构 7.2.2）。
 *
 * 安全保证：
 * - `storage.local` 里只有密文 + 主密钥，**查不到明文 key**。
 * - 明文 key 仅在 `getSecret` 返回值（内存）中短暂存在，模块内不缓存。
 * - 绝不写 `storage.sync`（见 storage.ts）。
 *
 * 存储布局：
 * - `__mk`     -> base64(32B 主密钥)
 * - `__sec:<ref>` -> base64(JSON({iv, ct}))   // iv=12B, ct=AES-GCM 密文(内含认证 tag)
 */
import { MASTER_KEY_STORAGE_KEY } from '../../shared/constants';
import { getDefaultSecretStorage, type SecretStorageArea } from './storage';

/** 密文条目前缀，便于在 storage 中区分密钥条目与其它配置。 */
const SECRET_ENTRY_PREFIX = '__sec:';

/** 生成密钥条目的完整 storage key。 */
function secretEntryKey(ref: string): string {
  return `${SECRET_ENTRY_PREFIX}${ref}`;
}

/** 字节 → base64（循环拼接，避免大数组 spread 栈限制）。 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** base64 → 字节。 */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface EncryptedBlob {
  /** 12 字节初始化向量，base64。 */
  iv: string;
  /** AES-GCM 密文（含认证 tag），base64。 */
  ct: string;
}

export interface SecretStore {
  /**
   * 加密并存储一个密钥。明文加密后立即丢弃，不缓存。
   * @param ref   secret-store 引用 id（即 EngineConfig.apiKeyRef）
   * @param value 明文密钥（如 API Key）
   */
  setSecret(ref: string, value: string): Promise<void>;
  /**
   * 读取并解密密钥，返回明文（仅内存使用）。
   * 不存在时返回 undefined。
   */
  getSecret(ref: string): Promise<string | undefined>;
  /** 删除指定密钥条目。 */
  deleteSecret(ref: string): Promise<void>;
  /** 是否存在该密钥条目。 */
  secretExists(ref: string): Promise<boolean>;
}

export interface SecretStoreOptions {
  /**
   * 持久化后端，默认 `chrome.storage.local`。
   * 测试可注入内存实现。
   */
  storage?: SecretStorageArea;
}

/**
 * 创建一个 secret-store 实例。
 *
 * @throws 若既未注入 storage，运行环境也无 `chrome.storage.local`（非扩展/未 mock 环境）。
 */
export function createSecretStore(options: SecretStoreOptions = {}): SecretStore {
  const resolved: SecretStorageArea | undefined = options.storage ?? getDefaultSecretStorage();
  if (!resolved) {
    throw new Error(
      'secret-store: no storage backend — chrome.storage.local not found and none injected',
    );
  }
  // 确定型绑定：闭包内不再有 narrowing 丢失（storage 恒为 SecretStorageArea）。
  const storage: SecretStorageArea = resolved;

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  /** 懒加载（或生成）AES-GCM 主密钥。 */
  async function getMasterKey(): Promise<CryptoKey> {
    const found = (await storage.get([MASTER_KEY_STORAGE_KEY]))[MASTER_KEY_STORAGE_KEY] as
      | string
      | undefined;
    let raw: Uint8Array<ArrayBuffer>;
    if (found) {
      raw = base64ToBytes(found);
    } else {
      // 方案 a：随机生成 256-bit 主密钥并落盘（仅一次）。
      raw = crypto.getRandomValues(new Uint8Array(32));
      await storage.set({ [MASTER_KEY_STORAGE_KEY]: bytesToBase64(raw) });
    }
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
  }

  async function setSecret(ref: string, value: string): Promise<void> {
    const key = await getMasterKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      encoder.encode(value),
    );
    const blob: EncryptedBlob = {
      iv: bytesToBase64(iv),
      ct: bytesToBase64(new Uint8Array(ciphertext)),
    };
    // 密文整体再包一层 base64，确保 storage.local 中仅见不透明字符串。
    const serialized = bytesToBase64(encoder.encode(JSON.stringify(blob)));
    await storage.set({ [secretEntryKey(ref)]: serialized });
  }

  async function getSecret(ref: string): Promise<string | undefined> {
    const stored = (await storage.get([secretEntryKey(ref)]))[secretEntryKey(ref)] as
      | string
      | undefined;
    if (!stored) return undefined;
    let blob: EncryptedBlob;
    try {
      blob = JSON.parse(decoder.decode(base64ToBytes(stored))) as EncryptedBlob;
    } catch {
      // 条目损坏/被篡改 → 视为不可用。
      return undefined;
    }
    const key = await getMasterKey();
    const iv = base64ToBytes(blob.iv);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      base64ToBytes(blob.ct),
    );
    return decoder.decode(plaintext);
  }

  async function deleteSecret(ref: string): Promise<void> {
    await storage.remove([secretEntryKey(ref)]);
  }

  async function secretExists(ref: string): Promise<boolean> {
    const found = await storage.get([secretEntryKey(ref)]);
    return found[secretEntryKey(ref)] !== undefined;
  }

  return { setSecret, getSecret, deleteSecret, secretExists };
}

/** 便捷判定：一个 storage key 是否是 secret-store 条目（供"无明文"自检/审计用）。 */
export function isSecretEntryKey(storageKey: string): boolean {
  return storageKey === MASTER_KEY_STORAGE_KEY || storageKey.startsWith(SECRET_ENTRY_PREFIX);
}
