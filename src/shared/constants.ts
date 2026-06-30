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
/** 加密主密钥存储键（架构 7.2 方案 a）。 */
export const MASTER_KEY_STORAGE_KEY = '__mk';
