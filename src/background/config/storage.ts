/**
 * 密钥存储所用的持久化后端抽象（架构 6.2 / 7.2）。
 *
 * MV3 Service Worker 下默认绑定 `chrome.storage.local`（支持 Promise，Chrome 88+）。
 * 抽象出最小接口便于在 Vitest 中注入内存实现，无需依赖真实扩展环境或 fake-chrome。
 *
 * 约束：密钥绝不进 `storage.sync`（会云同步，隐私风险）。本模块只读写 `storage.local`。
 */
export interface SecretStorageArea {
  /** 读取若干 key 的值；不存在的 key 不出现在返回对象里。 */
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface ChromeLikeArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

interface GlobalWithChrome {
  chrome?: {
    storage?: {
      local?: ChromeLikeArea;
    };
  };
}

/**
 * 取默认持久化后端：MV3 Service Worker 中的 `chrome.storage.local`。
 * 非扩展环境（如未注入 chrome 全局的测试）返回 undefined，由调用方注入。
 */
export function getDefaultSecretStorage(): SecretStorageArea | undefined {
  return (globalThis as GlobalWithChrome).chrome?.storage?.local;
}
