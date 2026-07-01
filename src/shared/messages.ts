/**
 * BatchTranslate 消息契约 —— content / SW / popup / options 通信的单一事实来源。
 *
 * 两条通道（架构 2.2），分两个 discriminated union 导出：
 *   1. RuntimeMessage —— 一次性消息 chrome.runtime.sendMessage（低频、无状态命令）
 *   2. PortMessage    —— Port 长连接 chrome.runtime.connect（翻译主通道，高频 / 双向）
 *
 * 判别字段统一为 `type`（字符串字面量）。两个 union 的 type 取值互不相交，因此即便
 * 混入同一处理函数也能靠 type 区分来源，不会产生歧义。
 *
 * 依赖方向：messages → types（单向），无循环依赖。
 */
import type {
  AppConfig,
  Item,
  TabTranslationState,
  TranslateMode,
  TranslationStatus,
} from './types';

// ════════════════════════════════════════════════════════════════════════
// 1. 一次性消息（chrome.runtime.sendMessage）
// ════════════════════════════════════════════════════════════════════════

/** popup → SW / options → SW 的命令。 */
export type ToSWMessages =
  | { type: 'GET_STATUS'; tabId: number }
  | { type: 'TOGGLE_TRANSLATE'; tabId: number; on: boolean }
  | { type: 'SWITCH_ENGINE'; engineId: string }
  | { type: 'SWITCH_MODE'; mode: TranslateMode }
  | { type: 'GET_CONFIG' }
  | { type: 'CONFIG_CHANGED' };

/** SW → popup 的响应。 */
export type FromSWMessages =
  | { type: 'STATUS'; tabId: number; state: TabTranslationState; progress: number }
  | { type: 'CONFIG'; config: AppConfig };

/** 一次性消息全集。 */
export type RuntimeMessage = ToSWMessages | FromSWMessages;

// ════════════════════════════════════════════════════════════════════════
// 2. Port 长连接消息（chrome.runtime.connect({name:"translate:<tabId>"})）
// ════════════════════════════════════════════════════════════════════════

/** content → SW（翻译主通道）。 */
export type ContentToSMPortMessage =
  | { type: 'TRANSLATE_BATCH'; items: Item[]; pageTitle?: string }
  | { type: 'CANCEL' };

/** SW → content。 */
export type SMToContentPortMessage =
  | { type: 'PROGRESS'; id: string; status: TranslationStatus }
  | { type: 'RESULT'; id: string; translated: string }
  | { type: 'ERROR'; id: string; reason: string }
  | { type: 'BATCH_DONE'; batchId: string }
  | { type: 'STREAM_CHUNK'; id: string; chunk: string }; // P1 流式预留

/** Port 消息全集。 */
export type PortMessage = ContentToSMPortMessage | SMToContentPortMessage;

// ════════════════════════════════════════════════════════════════════════
// type 字符串常量（运行时判别用，与 union 字面量一一对应，测试保证一致）
// ════════════════════════════════════════════════════════════════════════

export const RUNTIME_MESSAGE_TYPE = {
  GET_STATUS: 'GET_STATUS',
  TOGGLE_TRANSLATE: 'TOGGLE_TRANSLATE',
  SWITCH_ENGINE: 'SWITCH_ENGINE',
  SWITCH_MODE: 'SWITCH_MODE',
  GET_CONFIG: 'GET_CONFIG',
  CONFIG_CHANGED: 'CONFIG_CHANGED',
  STATUS: 'STATUS',
  CONFIG: 'CONFIG',
} as const;

export type RuntimeMessageType =
  (typeof RUNTIME_MESSAGE_TYPE)[keyof typeof RUNTIME_MESSAGE_TYPE];

export const PORT_MESSAGE_TYPE = {
  TRANSLATE_BATCH: 'TRANSLATE_BATCH',
  CANCEL: 'CANCEL',
  PROGRESS: 'PROGRESS',
  RESULT: 'RESULT',
  ERROR: 'ERROR',
  BATCH_DONE: 'BATCH_DONE',
  STREAM_CHUNK: 'STREAM_CHUNK',
} as const;

export type PortMessageType =
  (typeof PORT_MESSAGE_TYPE)[keyof typeof PORT_MESSAGE_TYPE];

// ════════════════════════════════════════════════════════════════════════
// 类型守卫
// ════════════════════════════════════════════════════════════════════════

const RUNTIME_TYPES: readonly string[] = Object.values(RUNTIME_MESSAGE_TYPE);
const PORT_TYPES: readonly string[] = Object.values(PORT_MESSAGE_TYPE);

function hasStringType(m: unknown): m is { type: string } {
  return typeof m === 'object' && m !== null && 'type' in m && typeof (m as { type: unknown }).type === 'string';
}

/** 是否为合法的一次性消息。 */
export function isRuntimeMessage(m: unknown): m is RuntimeMessage {
  return hasStringType(m) && RUNTIME_TYPES.includes(m.type);
}

/** 是否为合法的 Port 消息。 */
export function isPortMessage(m: unknown): m is PortMessage {
  return hasStringType(m) && PORT_TYPES.includes(m.type);
}

/**
 * 未知消息归类：'runtime' | 'port' | null。
 * 两 union 的 type 取值不相交，故无歧义。
 */
export function classifyMessage(m: unknown): 'runtime' | 'port' | null {
  if (isRuntimeMessage(m)) return 'runtime';
  if (isPortMessage(m)) return 'port';
  return null;
}

/**
 * 单 type 守卫工厂：收窄 union 到 type 匹配的成员。
 * 谓词 `m is M & { type: T }` 在 if 块内令 TS 自动暴露该成员的载荷字段。
 */
function typeGuard<T extends string>(type: T) {
  return <M extends { type: string }>(m: M): m is M & { type: T } => m.type === type;
}

// RuntimeMessage 单 type 守卫
export const isGetStatus = typeGuard(RUNTIME_MESSAGE_TYPE.GET_STATUS);
export const isToggleTranslate = typeGuard(RUNTIME_MESSAGE_TYPE.TOGGLE_TRANSLATE);
export const isSwitchEngine = typeGuard(RUNTIME_MESSAGE_TYPE.SWITCH_ENGINE);
export const isSwitchMode = typeGuard(RUNTIME_MESSAGE_TYPE.SWITCH_MODE);
export const isGetConfig = typeGuard(RUNTIME_MESSAGE_TYPE.GET_CONFIG);
export const isConfigChanged = typeGuard(RUNTIME_MESSAGE_TYPE.CONFIG_CHANGED);
export const isStatus = typeGuard(RUNTIME_MESSAGE_TYPE.STATUS);
export const isConfig = typeGuard(RUNTIME_MESSAGE_TYPE.CONFIG);

// PortMessage 单 type 守卫
export const isTranslateBatch = typeGuard(PORT_MESSAGE_TYPE.TRANSLATE_BATCH);
export const isCancel = typeGuard(PORT_MESSAGE_TYPE.CANCEL);
export const isProgress = typeGuard(PORT_MESSAGE_TYPE.PROGRESS);
export const isResult = typeGuard(PORT_MESSAGE_TYPE.RESULT);
export const isError = typeGuard(PORT_MESSAGE_TYPE.ERROR);
export const isBatchDone = typeGuard(PORT_MESSAGE_TYPE.BATCH_DONE);
export const isStreamChunk = typeGuard(PORT_MESSAGE_TYPE.STREAM_CHUNK);

/**
 * exhaustive switch 辅助：在 switch(msg.type) 的 default 分支调用。
 * 新增 union 成员后若忘记补 case，TS 在 default 处因 m 不再是 never 而编译报错。
 */
export function assertNeverType(value: never): never {
  throw new Error(`Unexpected message: ${JSON.stringify(value)}`);
}
