/**
 * recovery.ts —— MV3 Service Worker 队列持久化 + chrome.alarms 恢复。
 *
 * 解决架构第 9 节首要风险：SW 被浏览器卸载导致翻译中断。SW 非持久会随时被回收，
 * 故任何「翻译进行中」的状态都不能只放内存，必须落 storage.local；定时不能用
 * setTimeout/setInterval 保活（SW 卸载即丢），只能用 chrome.alarms。
 *
 * 设计要点（对齐架构 5.3 / 6.2 / 9）：
 *   1. 批次状态写 storage.local，键名 `config.queue.<batchId>`（见 batchStorageKey）。
 *      采用「每批一个键」的扁平命名空间，而非塞进单一 config 对象 —— 翻译每完成一段
 *      都要落盘，扁平键使每批写入原子、互不阻塞，且绝不与 config-store 的整对象读改写
 *      竞争（任务契约 `config.queue.{batchId}` 即读作扁平键）。
 *   2. 定时只用 chrome.alarms（periodInMinutes 0.5 = 每 30s 检查）；SW 启动
 *      （onStartup / onInstalled）也触发一次恢复检查。
 *   3. 恢复靠 batchId / item id 幂等：resume 只重翻 missing 段，已 done / 已缓存的不重翻。
 *      真正的幂等由 ResumePort（orchestrator）实现，recovery 只负责扫描 / 调度 / 清理。
 *   4. 依赖注入：本模块不 import 尚未实现的 orchestrator / queue —— 通过 ResumePort /
 *      TabPortLookup 端口注入，调用方（background.ts 装配）在 P0-7 落地后接线。
 *   5. 状态全落 storage.local，不依赖内存（内存态仅作同一 SW 生命周期内的去重护栏，
 *      SW 重启后丢失无碍，幂等由落盘状态 + 缓存保证）。
 *
 * 接线边界（待其他 issue 落地，本模块已为它们备好 API）：
 *   - scheduler/queue.ts（P0-5 / TRA-6，bt-core）：入队调 createBatchState + saveBatchState；
 *     每段成功调 recordItemDone；失败调 recordItemFailed；整批完成调 completeBatch。
 *   - orchestrator.ts（P0-7 / TRA-10，bt-backend）：实现 ResumePort.resume —— 内部查缓存命中
 *     → 打包 missing → 调度重翻，幂等回填，返回剩余 missing。
 *   - entrypoints/background.ts（P0-1 / P0-7）：调 setupRecovery() 装配，content port 重连时
 *     调 resumeForTab(tabId, deps) 触发该 tab 未完成批次的续传。
 */
import type { BatchState, Item, TranslateMode } from '../shared/types';
import {
  DEFAULT_MAX_RETRIES,
  RECOVERY_ALARM_NAME,
  RECOVERY_ALARM_PERIOD_MIN,
  STORAGE_KEY_CONFIG,
} from '../shared/constants';

// ════════════════════════════════════════════════════════════════════════
// 类型
// ════════════════════════════════════════════════════════════════════════

/** 批次在持久化队列中的生命周期状态。 */
export type BatchStatus = 'pending' | 'in_progress' | 'done' | 'failed' | 'cancelled';

/**
 * 续传所需上下文。orchestrator 入队时随批次一起落盘，SW 卸载重连后凭此重建翻译参数。
 * promptFingerprint 与 cache-key 对齐，保证换提示词不命中旧缓存（架构 6.1 / 9）。
 */
export interface ResumeContext {
  engineId: string;
  targetLang: string;
  sourceLang: string;
  mode: TranslateMode;
  /** 提示词指纹，续传重翻时与 cache-key 保持一致。 */
  promptFingerprint: string;
}

/**
 * 持久化的批次状态。extends 共享 BatchState（TRA-3 已合并，本任务不改动它以免冲突），
 * 追加恢复所需元数据（status / 时间戳 / ctx）。存 storage.local `config.queue.<batchId>`。
 */
export interface PersistedBatchState extends BatchState {
  status: BatchStatus;
  createdAt: number;
  updatedAt: number;
  ctx: ResumeContext;
}

/** orchestrator 续传的返回：剩余仍未完成的 item id；空数组表示批次完成。 */
export interface ResumeOutcome {
  batchId: string;
  remainingMissing: string[];
}

/**
 * 续传端口 —— 由 orchestrator（P0-7）实现并注入。recovery 不直接编排翻译，只调此端口。
 * 实现方必须幂等：只重翻 state.items 中不在 doneIds 的段，已 done / 已缓存段不重翻，
 * 结果回写缓存并通过 content port 回传 RESULT。
 */
export interface ResumePort {
  resume(state: PersistedBatchState): Promise<ResumeOutcome>;
}

/** 查某 tab 的 content port 是否已连接（content 重连后续传的前提）。由 background 装配注入。 */
export type TabPortLookup = (tabId: number) => boolean;

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

/** 恢复运行期依赖（全部注入，便于测试与解耦）。 */
export interface RecoveryDeps {
  /** orchestrator 续传实现。 */
  resumePort: ResumePort;
  /** content port 连接查询。 */
  tabLookup: TabPortLookup;
  /** 可注入时钟（默认 Date.now），测试用确定值。 */
  now?: () => number;
  /** 批次被视为孤儿（tab 长期未重连）的阈值，超过则清理。默认 24 小时。 */
  staleAfterMs?: number;
  /** 单批续传尝试上限，超过则标记 failed 并清理。默认 DEFAULT_MAX_RETRIES(5)。 */
  maxAttempts?: number;
  logger?: Logger;
  /** 同一 SW 生命周期内防止并发重复续传同一批的护栏（setupRecovery 自动创建并复用）。 */
  inFlight?: Set<string>;
}

/** recoverOnce 的一次扫描结果，供日志 / 测试断言。 */
export interface RecoveryRunResult {
  /** 扫描到的未完成批次数。 */
  scanned: number;
  /** 实际调用 resume 的批次数。 */
  resumed: number;
  /** 续传后完成的批次数。 */
  completed: number;
  /** 本次清理的批次数（终态残留 / 超重试 / 孤儿）。 */
  pruned: number;
}

/** content 重连续传的返回。 */
export interface ResumeForTabResult {
  batchId: string;
  /** 该批次已 done 的 item id，供 content 端 paragraph-registry 避免重复注入。 */
  doneIds: string[];
  /** 本次是否真的触发了 resume（已在续传中则为 false）。 */
  resumed: boolean;
}

/** setupRecovery 返回的手柄。 */
export interface RecoveryHandle {
  /** 手动触发一次恢复扫描（测试 / 调试）。 */
  recover: () => Promise<RecoveryRunResult>;
  /** 卸载：移除监听器并清除 alarm（扩展卸载 / 测试清理）。 */
  teardown: () => Promise<void>;
}

// ════════════════════════════════════════════════════════════════════════
// 默认值
// ════════════════════════════════════════════════════════════════════════

/** 孤儿批次清理阈值：24 小时未重连视为彻底放弃（正常关闭 / 休眠远短于此，能续传）。 */
const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

const NOOP_LOGGER: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
};

function defaultNow(): number {
  return Date.now();
}

// ════════════════════════════════════════════════════════════════════════
// chrome.* 最小接口（不依赖 @types/chrome，可被测试 mock）
// ════════════════════════════════════════════════════════════════════════

interface ChromeAlarm {
  name: string;
}

interface EventLike<Args extends unknown[]> {
  addListener(cb: (...args: Args) => void): void;
  removeListener(cb: (...args: Args) => void): void;
}

interface ChromeAlarmsApi {
  create(name: string, info: { periodInMinutes?: number; delayInMinutes?: number }): void;
  clear(name: string, cb: (wasCleared: boolean) => void): void;
  onAlarm: EventLike<[alarm: ChromeAlarm]>;
}

interface ChromeRuntimeApi {
  onStartup: EventLike<[]>;
  onInstalled: EventLike<[details: unknown]>;
}

interface ChromeStorageArea {
  get(keys: string | string[] | null, cb: (items: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, cb: () => void): void;
  remove(keys: string | string[], cb: () => void): void;
}

interface ChromeRecoveryApi {
  alarms: ChromeAlarmsApi;
  runtime: ChromeRuntimeApi;
  storage: { local: ChromeStorageArea };
}

function getChrome(): ChromeRecoveryApi {
  const c = (globalThis as { chrome?: ChromeRecoveryApi }).chrome;
  if (!c || !c.alarms || !c.storage?.local || !c.runtime) {
    throw new Error(
      'batchtranslate recovery: chrome.* (alarms/storage.local/runtime) unavailable',
    );
  }
  return c;
}

// ════════════════════════════════════════════════════════════════════════
// 存储键
// ════════════════════════════════════════════════════════════════════════

/**
 * storage.local 队列键前缀：`config.queue.`（架构 6.2 / 任务契约 `config.queue.{batchId}`）。
 * 扁平命名，每批一个键，写入原子且不与主 config 对象竞争。
 */
const QUEUE_KEY_PREFIX = `${STORAGE_KEY_CONFIG}.queue.`;

/** 单批存储键。 */
export function batchStorageKey(batchId: string): string {
  return `${QUEUE_KEY_PREFIX}${batchId}`;
}

// ════════════════════════════════════════════════════════════════════════
// storage.local promise 包装（回调式 chrome API → Promise）
// ════════════════════════════════════════════════════════════════════════

function storageGet(keys: string | string[] | null): Promise<Record<string, unknown>> {
  return new Promise((resolve) => getChrome().storage.local.get(keys, resolve));
}

function storageSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => getChrome().storage.local.set(items, resolve));
}

function storageRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve) => getChrome().storage.local.remove(keys, resolve));
}

// ════════════════════════════════════════════════════════════════════════
// 派生计算（纯函数）
// ════════════════════════════════════════════════════════════════════════

/** 批次是否已结算（所有 item 均在 doneIds 或 failedIds 内）。 */
export function isBatchFinished(state: BatchState): boolean {
  const settled = new Set<string>([...state.doneIds, ...state.failedIds]);
  return state.items.every((it) => settled.has(it.id));
}

/** 尚未完成的 item id（不在 doneIds 也不在 failedIds）—— resume 重翻的对象。 */
export function missingIdsOf(state: BatchState): string[] {
  const settled = new Set<string>([...state.doneIds, ...state.failedIds]);
  return state.items.filter((it) => !settled.has(it.id)).map((it) => it.id);
}

/** 未终止（仍需恢复）的状态：pending / in_progress。 */
function isActiveStatus(status: BatchStatus): boolean {
  return status === 'pending' || status === 'in_progress';
}

// ════════════════════════════════════════════════════════════════════════
// 持久化 CRUD
// ════════════════════════════════════════════════════════════════════════

/** 校验并窄化为 PersistedBatchState；非法值（键污染）返回 undefined。 */
function coercePersisted(v: unknown): PersistedBatchState | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (
    typeof o.batchId !== 'string' ||
    typeof o.tabId !== 'number' ||
    !Array.isArray(o.items) ||
    !Array.isArray(o.doneIds) ||
    !Array.isArray(o.failedIds) ||
    typeof o.attempts !== 'number' ||
    typeof o.status !== 'string' ||
    typeof o.createdAt !== 'number' ||
    typeof o.updatedAt !== 'number' ||
    typeof o.ctx !== 'object' ||
    o.ctx === null
  ) {
    return undefined;
  }
  return o as unknown as PersistedBatchState;
}

/** 落盘整批状态。 */
export async function saveBatchState(state: PersistedBatchState): Promise<void> {
  await storageSet({ [batchStorageKey(state.batchId)]: state });
}

/** 读取单批；不存在或非法返回 undefined。 */
export async function loadBatchState(batchId: string): Promise<PersistedBatchState | undefined> {
  const key = batchStorageKey(batchId);
  const items = await storageGet(key);
  return coercePersisted(items[key]);
}

/** 删除单批（完成 / 放弃后清理）。 */
export async function removeBatchState(batchId: string): Promise<void> {
  await storageRemove(batchStorageKey(batchId));
}

/** 列出所有持久化批次（扫描队列键前缀，忽略 config 等其他键）。 */
export async function listBatchStates(): Promise<PersistedBatchState[]> {
  const all = await storageGet(null);
  const out: PersistedBatchState[] = [];
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith(QUEUE_KEY_PREFIX)) continue;
    const s = coercePersisted(val);
    if (s) out.push(s);
  }
  return out;
}

/** 仅列出未终止（pending / in_progress）的批次 —— 恢复扫描的输入。 */
export async function listUnfinishedBatches(): Promise<PersistedBatchState[]> {
  const all = await listBatchStates();
  return all.filter((s) => isActiveStatus(s.status));
}

/** 某 tab 当前未完成的批次（content 重连续传用）。同一 tab 至多一个在途批次。 */
export async function getActiveBatchForTab(
  tabId: number,
): Promise<PersistedBatchState | undefined> {
  const unfinished = await listUnfinishedBatches();
  return unfinished.find((s) => s.tabId === tabId);
}

// ════════════════════════════════════════════════════════════════════════
// 入队构造 + 增量落盘
// ════════════════════════════════════════════════════════════════════════

/** createBatchState 的入参。 */
export interface CreateBatchStateOptions {
  batchId: string;
  tabId: number;
  items: Item[];
  ctx: ResumeContext;
  now?: number;
}

/**
 * 构造一份初始持久化批次状态（queue.ts 入队时调：createBatchState → saveBatchState）。
 * 所有 item 初始 pending，done / failed 为空，attempts=0。
 */
export function createBatchState(opts: CreateBatchStateOptions): PersistedBatchState {
  const now = opts.now ?? Date.now();
  return {
    batchId: opts.batchId,
    tabId: opts.tabId,
    items: opts.items,
    doneIds: [],
    failedIds: [],
    attempts: 0,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
    ctx: opts.ctx,
  };
}

// 每批一把串行锁：同批的多次异步读改写排队执行，防止 await 交错丢更新。
const writeLocks = new Map<string, Promise<unknown>>();

function withBatchLock<T>(batchId: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeLocks.get(batchId) ?? Promise.resolve();
  // fn 无论成败都接续，保证链不断；吞掉的错误仅用于维持锁链，真实错误经 next 抛给调用方。
  const next = prev.then(fn, fn);
  writeLocks.set(
    batchId,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
}

/** 记录一段翻译成功：加入 doneIds（去重）、移出 failedIds、刷新 updatedAt；完成则翻 done。 */
export async function recordItemDone(
  batchId: string,
  itemId: string,
  now: number = Date.now(),
): Promise<PersistedBatchState | undefined> {
  return withBatchLock(batchId, async () => {
    const state = await loadBatchState(batchId);
    if (!state) return undefined;
    const done = new Set(state.doneIds);
    done.add(itemId);
    const failedIds = state.failedIds.filter((id) => id !== itemId);
    const draft: BatchState = { ...state, doneIds: [...done], failedIds };
    const next: PersistedBatchState = {
      ...state,
      doneIds: [...done],
      failedIds,
      status: isBatchFinished(draft) ? 'done' : 'in_progress',
      updatedAt: now,
    };
    await saveBatchState(next);
    return next;
  });
}

/** 记录一段翻译失败：加入 failedIds（去重）；已 done 的不动；全部结算则翻 failed。 */
export async function recordItemFailed(
  batchId: string,
  itemId: string,
  now: number = Date.now(),
): Promise<PersistedBatchState | undefined> {
  return withBatchLock(batchId, async () => {
    const state = await loadBatchState(batchId);
    if (!state) return undefined;
    if (state.doneIds.includes(itemId)) return state; // 已成功的不再标失败
    const failed = new Set(state.failedIds);
    failed.add(itemId);
    const failedIds = [...failed];
    const draft: BatchState = { ...state, failedIds };
    const next: PersistedBatchState = {
      ...state,
      failedIds,
      status: isBatchFinished(draft) ? 'failed' : 'in_progress',
      updatedAt: now,
    };
    await saveBatchState(next);
    return next;
  });
}

/** 续传尝试计数 +1（resume 仍有缺失或抛错时调；超 maxAttempts 会被 prune 清理）。 */
export async function bumpAttempts(
  batchId: string,
  now: number = Date.now(),
): Promise<PersistedBatchState | undefined> {
  return withBatchLock(batchId, async () => {
    const state = await loadBatchState(batchId);
    if (!state) return undefined;
    const next: PersistedBatchState = {
      ...state,
      attempts: state.attempts + 1,
      status: 'in_progress', // 正在续传 → 视为进行中
      updatedAt: now,
    };
    await saveBatchState(next);
    return next;
  });
}

/** 直接改批次状态（cancel 等）。 */
export async function markBatchStatus(
  batchId: string,
  status: BatchStatus,
  now: number = Date.now(),
): Promise<PersistedBatchState | undefined> {
  return withBatchLock(batchId, async () => {
    const state = await loadBatchState(batchId);
    if (!state) return undefined;
    const next: PersistedBatchState = { ...state, status, updatedAt: now };
    await saveBatchState(next);
    return next;
  });
}

/**
 * 整批完成：从持久化队列移除。结果已在缓存 + DOM，无需续传；content 端 paragraph-registry
 * 持久化已渲染 id，重连后已渲染段不重复注入，未渲染但已翻译段从缓存重发 RESULT。
 */
export async function completeBatch(batchId: string): Promise<void> {
  await removeBatchState(batchId);
}

// ════════════════════════════════════════════════════════════════════════
// 过期 / 孤儿批次清理
// ════════════════════════════════════════════════════════════════════════

function isStale(state: PersistedBatchState, deps: RecoveryDeps): boolean {
  const staleAfter = deps.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const now = deps.now ?? defaultNow;
  return now() - state.updatedAt > staleAfter;
}

/**
 * 清理持久化队列：终态残留（done/failed/cancelled 久留）、超过重试上限、长期孤儿
 * （超期且 tab 未连接）。正常关闭 / 休眠远短于 staleAfterMs，不会误清。返回清理数。
 */
export async function pruneStaleBatches(
  deps: RecoveryDeps,
): Promise<{ pruned: number }> {
  const logger = deps.logger ?? NOOP_LOGGER;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_RETRIES;
  const all = await listBatchStates();
  let pruned = 0;
  for (const state of all) {
    // 终态批次残留 → 清理（安全网：completeBatch 之外残留的 done 批次不至久留）。
    if (!isActiveStatus(state.status)) {
      await removeBatchState(state.batchId);
      pruned++;
      continue;
    }
    // 超过重试上限 → 清理（failed 段已在 UI 显示原位错误占位）。
    if (state.attempts >= maxAttempts) {
      logger.warn('recovery: batch exceeded max attempts, pruning', state.batchId, state.attempts);
      await removeBatchState(state.batchId);
      pruned++;
      continue;
    }
    // 长期孤儿（超期且 tab 未连接）→ 清理。tab 仍连接的不清（可能正续传）。
    if (isStale(state, deps) && !deps.tabLookup(state.tabId)) {
      logger.warn('recovery: stale orphan batch pruned', state.batchId);
      await removeBatchState(state.batchId);
      pruned++;
      continue;
    }
  }
  return { pruned };
}

// ════════════════════════════════════════════════════════════════════════
// 恢复扫描 + 续传
// ════════════════════════════════════════════════════════════════════════

function resolveDeps(deps: RecoveryDeps): RecoveryDeps {
  return {
    ...deps,
    now: deps.now ?? defaultNow,
    inFlight: deps.inFlight ?? new Set<string>(),
  };
}

/**
 * 执行一次恢复扫描：先清理过期 / 孤儿批次，再为「tab 已连接」的未完成批次触发幂等续传。
 * content 未重连的批次跳过（等下次 alarm 或 resumeForTab），不强行重翻（无 port 回传无意义）。
 */
export async function recoverOnce(deps: RecoveryDeps): Promise<RecoveryRunResult> {
  const full = resolveDeps(deps);
  const logger = full.logger ?? NOOP_LOGGER;
  const now = full.now ?? defaultNow;
  const inFlight = full.inFlight ?? new Set<string>();

  // 1. 清理过期 / 孤儿 / 终态残留。
  const { pruned } = await pruneStaleBatches(full);

  // 2. 扫描未完成批次，逐个续传（仅 tab 已连接者）。
  const unfinished = await listUnfinishedBatches();
  let resumed = 0;
  let completed = 0;
  for (const state of unfinished) {
    if (inFlight.has(state.batchId)) {
      logger.debug('recovery: batch already resuming, skip', state.batchId);
      continue;
    }
    if (!deps.tabLookup(state.tabId)) {
      logger.debug('recovery: tab not connected, defer', state.batchId);
      continue;
    }
    inFlight.add(state.batchId);
    resumed++; // 计入「尝试续传」（无论成败）
    try {
      logger.info(
        'recovery: resuming batch',
        state.batchId,
        'missing=',
        missingIdsOf(state).length,
      );
      const outcome = await deps.resumePort.resume(state);
      if (outcome.remainingMissing.length === 0) {
        await completeBatch(state.batchId);
        completed++;
      } else {
        // 仍有缺失：bump 尝试计数，下轮 alarm 再判（超 maxAttempts 会被 prune）。
        await bumpAttempts(state.batchId, now());
      }
    } catch (err) {
      logger.warn('recovery: resume threw', state.batchId, err);
      await bumpAttempts(state.batchId, now());
    } finally {
      inFlight.delete(state.batchId);
    }
  }

  return { scanned: unfinished.length, resumed, completed, pruned };
}

/**
 * content port 重连时调用：为该 tab 的未完成批次触发续传。
 * 返回该批次已 done 的 item id，供 content 端 paragraph-registry 避免重复注入
 * （已渲染段不重复注入；未渲染但已翻译的段从缓存重发 RESULT）。无在途批次返回 undefined。
 */
export async function resumeForTab(
  tabId: number,
  deps: RecoveryDeps,
): Promise<ResumeForTabResult | undefined> {
  const full = resolveDeps(deps);
  const logger = full.logger ?? NOOP_LOGGER;
  const now = full.now ?? defaultNow;
  const inFlight = full.inFlight ?? new Set<string>();

  const state = await getActiveBatchForTab(tabId);
  if (!state) return undefined;
  if (inFlight.has(state.batchId)) {
    return { batchId: state.batchId, doneIds: state.doneIds, resumed: false };
  }
  inFlight.add(state.batchId);
  try {
    const outcome = await deps.resumePort.resume(state);
    if (outcome.remainingMissing.length === 0) {
      await completeBatch(state.batchId);
    } else {
      await bumpAttempts(state.batchId, now());
    }
    return { batchId: state.batchId, doneIds: state.doneIds, resumed: true };
  } catch (err) {
    logger.warn('recovery: resumeForTab threw', state.batchId, err);
    await bumpAttempts(state.batchId, now());
    return { batchId: state.batchId, doneIds: state.doneIds, resumed: true };
  } finally {
    inFlight.delete(state.batchId);
  }
}

// ════════════════════════════════════════════════════════════════════════
// 装配：alarm + SW 启动钩子
// ════════════════════════════════════════════════════════════════════════

/**
 * 装配恢复机制：创建周期 alarm（每 30s），注册 onAlarm / onStartup / onInstalled 触发
 * recoverOnce。返回手柄供手动触发 / 卸载。在 background.ts 顶层调用一次。
 *
 * 幂等性：alarm.create 同名会刷新；inFlight 护栏随 setupRecovery 闭包存活于整个 SW 生命周期。
 */
export function setupRecovery(deps: RecoveryDeps): RecoveryHandle {
  const chrome = getChrome();
  const logger = deps.logger ?? NOOP_LOGGER;
  const full = resolveDeps(deps);

  // 周期 alarm：每 30s 检查恢复（MV3 生产最小周期即 30s）。
  chrome.alarms.create(RECOVERY_ALARM_NAME, {
    periodInMinutes: RECOVERY_ALARM_PERIOD_MIN,
  });

  const sweep = (origin: string) => (err?: unknown) =>
    void recoverOnce(full).catch((e) =>
      logger.warn(`recovery: ${origin} sweep failed`, e),
    );

  const onAlarm = (alarm: ChromeAlarm): void => {
    if (alarm.name !== RECOVERY_ALARM_NAME) return;
    sweep('alarm')();
  };
  const onStartup = (): void => sweep('onStartup')();
  const onInstalled = (): void => sweep('onInstalled')();

  chrome.alarms.onAlarm.addListener(onAlarm);
  chrome.runtime.onStartup.addListener(onStartup);
  chrome.runtime.onInstalled.addListener(onInstalled);

  return {
    recover: () => recoverOnce(full),
    teardown: async () => {
      chrome.alarms.onAlarm.removeListener(onAlarm);
      chrome.runtime.onStartup.removeListener(onStartup);
      chrome.runtime.onInstalled.removeListener(onInstalled);
      await new Promise<void>((resolve) =>
        chrome.alarms.clear(RECOVERY_ALARM_NAME, () => resolve()),
      );
    },
  };
}
