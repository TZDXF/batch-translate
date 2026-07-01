/**
 * BatchTranslate 共享常量 —— 引擎 provider 枚举、默认调度参数、命名约定。
 * 值对齐 docs/ARCHITECTURE.md 第 2.2、5.2、5.3、6.1 节。
 */
import type { EngineProvider, SchedulingConfig, Shortcuts } from './types';
/** 运行时引擎 provider 列表（与 EngineProvider 类型一一对应）。 */
export const ENGINE_PROVIDERS: readonly EngineProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'ollama',
  'openai-compatible',
];

// ─── 调度默认值（架构 5.3） ───────────────────────────────────────────────
export const DEFAULT_MAX_CONCURRENT = 3;
export const DEFAULT_RPS = 2;
/** 0 = 关闭额度保护。 */
export const DEFAULT_TPM_LIMIT = 0;
export const DEFAULT_MAX_RETRIES = 5;
export const MAX_ITEMS_PER_BATCH = 20;
export const DEFAULT_BATCH_TOKEN_BUDGET_RATIO = 0.7;

/** 默认调度参数，供 config 初始化与 options 重置使用。 */
export const DEFAULT_SCHEDULING: Readonly<SchedulingConfig> = {
  maxConcurrent: DEFAULT_MAX_CONCURRENT,
  rps: DEFAULT_RPS,
  tpmLimit: DEFAULT_TPM_LIMIT,
  maxRetries: DEFAULT_MAX_RETRIES,
  itemsPerBatch: MAX_ITEMS_PER_BATCH,
  batchTokenBudgetRatio: DEFAULT_BATCH_TOKEN_BUDGET_RATIO,
};

// ─── 流式渲染默认（P1-2，架构 2.2） ────────────────────────────────────────
/**
 * 流式默认关闭（零回归验收项：关闭时行为与 P0 整批一致）。
 * 用户在 options 开启后，长页面译文边出边显。
 */
export const DEFAULT_STREAMING: Readonly<{ enabled: boolean; engineUnsupportedFallback: boolean }> = {
  enabled: false,
  engineUnsupportedFallback: true,
};

// ─── 快捷键默认值（P1-3，架构 P1 路线图） ─────────────────────────────────
/** 默认快捷键映射。Alt 系前缀避免与浏览器/网页常用快捷键冲突。 */
export const DEFAULT_SHORTCUTS: Readonly<Shortcuts> = {
  toggle: 'Alt+Shift+T',
  cycleDisplayMode: 'Alt+Shift+D',
  retranslate: 'Alt+Shift+R',
};

// ─── 退避（架构 5.2） ─────────────────────────────────────────────────────
/** 指数退避基数：min(BASE * 2^n, MAX)。 */
export const BASE_BACKOFF_MS = 1_000;
/** 退避上限。 */
export const MAX_BACKOFF_MS = 60_000;
/** ±20% jitter。 */
export const BACKOFF_JITTER = 0.2;

// ─── token 预估字符比例（架构 4.5，保守取大） ────────────────────────────
/** tok/char，中文。 */
export const CN_TOKEN_RATIO = 1.5;
/** tok/char，英文。 */
export const EN_TOKEN_RATIO = 0.25;

// ─── Port 长连接命名（架构 2.2: connect({name:"translate:<tabId>"})） ──────
export const TRANSLATE_PORT_PREFIX = 'translate:';

/** 构造 per-tab 翻译 Port 名称。 */
export function translatePortName(tabId: number): string {
  return `${TRANSLATE_PORT_PREFIX}${tabId}`;
}

/**
 * 从 Port 名称解析 tabId；非翻译 Port 返回 undefined。
 * chrome tab id 为正整数（<=0 视为无效）。
 */
export function parseTranslatePortName(name: string): number | undefined {
  if (!name.startsWith(TRANSLATE_PORT_PREFIX)) return undefined;
  const tabId = Number(name.slice(TRANSLATE_PORT_PREFIX.length));
  return Number.isInteger(tabId) && tabId > 0 ? tabId : undefined;
}

// ─── 缓存 IndexedDB（架构 6.1） ──────────────────────────────────────────
export const CACHE_DB_NAME = 'batchtranslate-cache';
export const CACHE_DB_VERSION = 1;
export const CACHE_STORE_TRANSLATIONS = 'translations';
export const CACHE_STORE_GLOSSARIES = 'glossaries';
export const CACHE_STORE_META = 'meta';
export const CACHE_DEFAULT_MAX_SIZE_MB = 100;

// ─── 队列恢复 alarms（架构 9：每 30s 检查恢复） ───────────────────────────
export const RECOVERY_ALARM_NAME = 'batchtranslate-recovery';
/** chrome.alarms 在 MV3 生产环境最小周期为 30s。 */
export const RECOVERY_ALARM_PERIOD_MIN = 0.5;

// ─── storage 键（架构 6.2） ───────────────────────────────────────────────
export const STORAGE_KEY_CONFIG = 'config';
/**
 * 加密主密钥存储键。
 * - 方案 a（P0）：随机 256-bit 主密钥 base64 存 storage.local（仅混淆）。
 * - 方案 b（P1，TRA-22）：主密码 PBKDF2 派生主密钥，密码不落盘；此键仅保留作
 *   迁移期存量方案 a 密钥的解密源，迁移完成后由 master-key.ts 删除。
 */
export const MASTER_KEY_STORAGE_KEY = '__mk';
/** 方案 b：PBKDF2 salt（base64，随机 16 字节）存 storage.local 的键。 */
export const MASTER_KEY_SALT_STORAGE_KEY = '__mk_salt';
/** 方案 b：主密码校验值（派生密钥加密固定 token 的密文）存 storage.local 的键。 */
export const MASTER_KEY_VERIFIER_STORAGE_KEY = '__mk_verifier';
/** 方案 b：解锁态派生主密钥（base64 派生密钥材料）存 storage.session 的键。 */
export const MASTER_KEY_SESSION_KEY = '__mk_session';

// ─── PBKDF2 主密码派生参数（架构 7.2 方案 b，TRA-22） ─────────────────────
/**
 * PBKDF2 哈希算法。选用 SHA-512：OWASP Password Storage Cheat Sheet 当前建议
 * PBKDF2-HMAC-SHA512 ≥ 210000 次迭代（与 issue 约定 ≥210000 一致）。
 */
export const PBKDF2_HASH_ALGO = 'SHA-512';
/** PBKDF2 迭代次数（OWASP 2023+ 对 SHA-512 的下限建议）。 */
export const PBKDF2_ITERATIONS = 210_000;
/** PBKDF2 salt 字节长度（OWASP 建议 ≥64bit，取 128bit）。 */
export const PBKDF2_SALT_LENGTH = 16;
/** PBKDF2 派生密钥位数（AES-256 = 256bit）。 */
export const PBKDF2_DERIVED_BITS = 256;
