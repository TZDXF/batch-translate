/**
 * 翻译编排器 orchestrator —— Service Worker 翻译核心（架构 2.3 / 4.6）。
 *
 * 串联 Stage 2 全部模块，把整条翻译流水线跑通：
 *
 *   收任务 → 查缓存（命中段直接回填） → 打包切批 → 并发调度（gate + 令牌桶）
 *          → engine.translate → parseResponse → alignByIds
 *          → 部分对齐：缺段单独成批重发（不重翻整批）
 *          → 整批 parse 失败：degradeBatch 拆小批 → 再失败逐段单发
 *          → 每段成功即写缓存（幂等） → port 回传 RESULT/PROGRESS/BATCH_DONE/ERROR
 *          → CANCEL：AbortController 中止在途请求
 *
 * ── 为什么用依赖注入（DI）而非直接 import ──────────────────────────────────
 * Stage 2（P0-3 引擎 / P0-4 打包·协议 / P0-5 调度 / P0-6 缓存）与本任务并行开发，
 * 尚未合并到主干。直接静态 import 这些模块会让本文件在 Stage 2 落地前无法编译，
 * 也无法脱离真实引擎/缓存做集成测试（本任务明确要求「mock 引擎/缓存/port」）。
 *
 * 因此本文件只 import `src/shared/*`（P0-2 已交付的纯类型/契约），Stage 2 的
 * 具体实现以 `OrchestratorDeps` 接口注入。下方每个依赖接口都标注了它的来源
 * 模块路径与文档锚点，签名严格对齐各 Stage 2 issue 的验收契约 —— Stage 2 合并
 * 后，由 `runtime-deps.ts` 把真实模块接成 `OrchestratorDeps` 即可（见该文件）。
 *
 * ── SW 非持久边界（架构 9）─────────────────────────────────────────────────
 * 本任务为内存态：AbortController / 计数器 / tab 控制器映射都在内存。SW 被卸载
 * 即丢失。队列持久化与 chrome.alarms 恢复在 P0-10（TRA-11）处理，本文件不做
 * 落盘，仅在注释中标明边界。
 */
import type {
  AgentConfig,
  Batch,
  Item,
  SchedulingConfig,
  TabTranslationState,
  TranslateMode,
  TranslationStatus,
} from '../shared/types';
import type { SMToContentPortMessage } from '../shared/messages';
import {
  StreamingBatchParser,
  consumeStreamById,
  isStreamingEngine,
  type StreamingEngine,
} from './engines/stream-adapter';

// ═══════════════════════════════════════════════════════════════════════════
// Stage 2 依赖契约（DI 接口）—— 签名对齐各 Stage 2 issue 验收标准
// ═══════════════════════════════════════════════════════════════════════════

/** 引擎适配层统一接口（来源 src/background/engines/adapter.ts · P0-3 / TRA-4）。 */
export interface Engine {
  id: string;
  provider: string;
  translate(req: EngineTranslateRequest): Promise<EngineTranslateResponse>;
}

export interface EngineTranslateRequest {
  systemPrompt: string;
  userMessage: string;
  targetLang: string;
  /** OpenAI response_format / Gemini responseMimeType 等结构化约束开关（架构 4.4）。 */
  jsonMode: boolean;
  /** 中止信号，CANCEL 时触发；真实 fetch 会随 signal 中止。 */
  signal?: AbortSignal;
}

export interface EngineTranslateResponse {
  content: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

/** 批量协议（来源 src/background/batcher/protocol.ts · P0-4 / TRA-5）。 */
export interface Protocol {
  /** 系统提示词（架构 4.3，基础/智能体模式）。 */
  buildSystemPrompt(ctx: TranslateContext): string;
  /** 用户消息（架构 4.2 的 items JSON）。 */
  buildUserMessage(items: Item[]): string;
  /**
   * 提示词指纹（架构 6.1 cacheKey 组成之一）。换提示词/引擎配置 → 指纹变 → 不命中旧缓存。
   * 来源同 protocol（TRA-7 约定 fingerprint 由调用方/protocol 提供，解耦于 cache-key）。
   */
  fingerprint(ctx: TranslateContext): string;
  /**
   * 解析引擎原始响应：JSON.parse → 失败正则提取 `<json>`/`{...}` 再 parse → 仍失败标 parse_error
   * （架构 4.4）。注意：只判定「能否解析」，不做 id 对齐（对齐在 alignByIds）。
   */
  parseResponse(raw: string, batch: Batch): ParseOutcome;
  /**
   * id 对齐：校验返回 id 与输入一一对应（架构 4.6）。返回已对齐译文 + 缺失 id。
   * 多返/乱序容错，缺返进 missing。
   */
  alignByIds(parsed: unknown, batch: Batch): Alignment;
  /** 降级：整批失败时拆成更小批（20→4×5），供重试路径用（架构 4.6 / 4.5）。 */
  degradeBatch(batch: Batch): Batch[];
}

export type ParseOutcome = { ok: true; data: unknown } | { ok: false; error: 'parse_error' };

export interface Alignment {
  /** itemId → 译文。 */
  translated: Map<string, string>;
  /** 输入里有、响应里缺失的 itemId。 */
  missing: string[];
}

/** token 预估 + 分批打包（来源 src/background/batcher/{token-estimator,packer}.ts · P0-4 / TRA-5）。 */
export interface Packer {
  /** 按预算切批（架构 4.5）。 */
  pack(items: Item[], budget: TokenBudget): Batch[];
  /** 单段 token 预估（架构 4.5），用于重发批次的 scheduler cost 估算。 */
  estimateTokens(text: string): number;
}

/** 并发控制器（来源 src/background/scheduler/concurrency-controller.ts · P0-5 / TRA-6）。 */
export interface Scheduler {
  /**
   * 占并发槽 + 令牌桶（架构 5.1 gate + tokenBucket）。槽满时阻塞直到有释放。
   * cost 为 token 量，仅在启用 TPM 额度保护时参与限速（默认 tpmLimit=0 → cost 忽略）。
   */
  acquire(cost?: number): Promise<void>;
  /** 释放槽 + 退桶。 */
  release(cost?: number): void;
}

/** 退避重试（来源 src/background/scheduler/retry.ts · P0-5 / TRA-6）。 */
export interface Retry {
  /**
   * 包装可重试操作：429 尊重 Retry-After 取大、5xx/408/网络错指数退避 ±20% jitter、
   * 4xx 非 429 不重试直接抛（架构 5.2）。★ 必须把 AbortError 当作不可重试直接抛出，
   * 否则 CANCEL 后还会重发。
   */
  withRetry<T>(fn: (attempt: number) => Promise<T>, opts?: RetryOptions): Promise<T>;
}

export interface RetryOptions {
  maxRetries?: number;
}

/** 缓存条目（架构 6.1 translations store value）。 */
export interface CacheEntry {
  cacheKey: string;
  source: string;
  translated: string;
  engineId: string;
  promptFingerprint: string;
  targetLang: string;
  createdAt: number;
  hitCount: number;
  /** 可选，仅本地显示，绝不外传（架构 6.1 / 7）。 */
  sourceUrl?: string;
}

/** IndexedDB 缓存层 + cache-key（来源 src/background/cache/{cache-store,cache-key}.ts · P0-6 / TRA-7）。 */
export interface Cache {
  /** sha256(sourceText + engineId + promptFingerprint + targetLang)（架构 6.1）。 */
  cacheKey(source: string, engineId: string, promptFingerprint: string, targetLang: string): string;
  /** 批量查存（避免 N 次 round-trip）。未命中 key 不在返回 Map 中。 */
  getMany(keys: string[]): Promise<Map<string, CacheEntry>>;
  /** 幂等写存（每段成功即写）。 */
  set(entry: CacheEntry): Promise<void>;
}

/** 编排器全部依赖（Stage 2 接缝）。engine 走 ctx（可热切换），其余为稳定单例。 */
export interface OrchestratorDeps {
  protocol: Protocol;
  packer: Packer;
  scheduler: Scheduler;
  retry: Retry;
  cache: Cache;
  /**
   * 智能体模式批量执行器（P1-1）。仅当 ctx.mode === 'agent' 时启用：把单批的
   * 「agent 尝试 + 质量回退到基础模式」决策委托给它（runAgentBatch）。缺省/基础
   * 模式下走原有 callEngine → handleResult → degrade 路径，零回归。
   */
  agentRunner?: AgentBatchRunner;
  /** 进度广播给 popup（一次性消息 STATUS，架构 2.2 / 任务 #3）。由 port-server 绑定 tabId。 */
  broadcastStatus: (tabId: number, state: TabTranslationState, progress: number) => void;
}

/**
 * 智能体模式批量执行器产物（P1-1）。translated 为 agent+basic 回退并集；
 * failedIds 为两轮仍未得到的段；fallbackReason 为触发基础模式回退的原因。
 */
export interface AgentBatchOutcome {
  translated: Map<string, string>;
  failedIds: string[];
  fallbackReason?: 'parse_error' | 'empty_result' | 'alignment_failure';
}

/** 智能体模式批量执行器接口（由 runtime-deps 用 runAgentBatch 实现）。 */
export interface AgentBatchRunner {
  run(batch: Batch, ctx: TranslateContext, signal: AbortSignal): Promise<AgentBatchOutcome>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 编排器入参类型
// ═══════════════════════════════════════════════════════════════════════════

/** 单批 token 预算（架构 4.5 budget）。inputMax 为输入侧上限（含 overhead 由 packer 内部扣减）。 */
export interface TokenBudget {
  inputMax: number;
}

/** 单次 translateBatch 的上下文，由 port-server 从当前 AppConfig 解析后传入。 */
export interface TranslateContext {
  tabId: number;
  /** 解析后的活动引擎实例（translateBatch 直接调用它）。 */
  engine: Engine;
  /** 缓存 key 用的 engineId（一般等于 engine.id）。 */
  engineId: string;
  targetLang: string;
  sourceLang: 'auto' | string;
  mode: TranslateMode;
  /** 智能体模式配置（mode==='agent' 时有意义，基础模式可留空）。 */
  agent?: AgentConfig;
  scheduling: SchedulingConfig;
  budget: TokenBudget;
  /**
   * 流式渲染开关（P1-2 / TRA-17）。开启后，基础模式且引擎支持 translateStream 时
   * 走流式路径：逐 chunk 经 port 推 STREAM_CHUNK，边出边显。智能体模式 / 引擎不支持
   * 时回退非流式整批（零回归）。架构 2.2「流式（可选 P1）」。
   */
  streaming: boolean;
  /** 可选页面 URL，仅写入缓存条目本地字段，不随请求外发（架构 7.3）。 */
  sourceUrl?: string;
  /** 智能体模式页面上下文（标题/前段摘要，架构 4.3）。 */
  pageContext?: string;
}

/**
 * Port 抽象。真实 chrome.runtime.Port 满足此接口；测试注入 fake port。
 * 只暴露 postMessage：编排器不关心 port 的其它能力，断连由 port-server 在
 * onDisconnect 处理并触发 cancel。
 */
export interface OrchestratorPort {
  postMessage(msg: SMToContentPortMessage): void;
}

/** 编排器实例接口。 */
export interface Orchestrator {
  /** 主流程：items 全量进，逐段经 port 回传，全部 settle 后 resolve。 */
  translateBatch(items: Item[], ctx: TranslateContext, port: OrchestratorPort): Promise<void>;
  /** 中止某 tab 在途翻译（CANCEL / port 断连时调用）。无在途任务则 no-op。 */
  cancel(tabId: number): void;
  /** 某 tab 是否有在途任务（供 port-server 清理决策）。 */
  isActive(tabId: number): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════════════════════

/** 降级层级（架构 4.6 逐级降级链）。 */
type DegradeLevel = 'full' | 'degraded' | 'single';

/** 单批处理过程中的累计计数（闭包传递，避免散落参数）。 */
interface Counters {
  done: number;
  failed: number;
  total: number;
}

const ABORT_REASON = 'bt-cancel' as const;

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  return err instanceof Error && err.name === 'AbortError';
}

/** 当前时间戳（毫秒）。orchestrator 运行于 SW（非 workflow 脚本），Date 可用。 */
function nowMs(): number {
  return Date.now();
}

/** 创建编排器实例。 */
export function createOrchestrator(deps: OrchestratorDeps): Orchestrator {
  // tabId → 在途 AbortController。SW 非持久：内存态，卸载即丢（恢复见 P0-10）。
  const tabControllers = new Map<number, AbortController>();
  // 批次 id 序列（同 tab 域内递增，保证 BATCH_DONE batchId 唯一）。
  const batchSeq = new Map<number, number>();

  function nextBatchId(tabId: number): string {
    const n = (batchSeq.get(tabId) ?? 0) + 1;
    batchSeq.set(tabId, n);
    return `bt-batch-${tabId}-${n}`;
  }

  /** 构造重发批次（degrade 与 missing 重发都用），tokenEstimate 用 packer 重估。 */
  function makeBatch(tabId: number, items: Item[]): Batch {
    const tokenEstimate = items.reduce((sum, it) => sum + deps.packer.estimateTokens(it.text), 0);
    return { id: nextBatchId(tabId), items, tokenEstimate };
  }

  return {
    isActive(tabId: number): boolean {
      return tabControllers.has(tabId);
    },

    cancel(tabId: number): void {
      const ctrl = tabControllers.get(tabId);
      if (!ctrl) return;
      ctrl.abort(ABORT_REASON);
      // 控制器留在 Map 里：在途批次的 scheduleBatch 检测到 aborted 后自行收尾，
      // translateBatch 的 finally 会删除它。这里只负责触发中止信号。
    },

    async translateBatch(items, ctx, port): Promise<void> {
      const total = items.length;
      // 空任务直接完成。
      if (total === 0) {
        deps.broadcastStatus(ctx.tabId, 'done', 1);
        return;
      }

      const abort = new AbortController();
      tabControllers.set(ctx.tabId, abort);
      const counters: Counters = { done: 0, failed: 0, total };
      let cancelled = false;

      // 提示词指纹与系统提示词全批共用，预先算一次（必须在调度前，供 callEngine/cache 使用）。
      const fingerprint = deps.protocol.fingerprint(ctx);
      const systemPrompt = deps.protocol.buildSystemPrompt(ctx);

      // port 断连视为取消：postMessage 失败时置位，停止后续回传与请求。
      let disconnected = false;
      const emit = (msg: SMToContentPortMessage): void => {
        if (disconnected) return;
        try {
          port.postMessage(msg);
        } catch {
          // port 已断开（content 刷新 / tab 关闭）→ 当作取消。
          disconnected = true;
          cancelled = true;
          abort.abort(ABORT_REASON);
        }
      };

      const broadcastProgress = (state: TabTranslationState): void => {
        const settled = counters.done + counters.failed;
        const progress = total === 0 ? 1 : Math.min(settled / total, 1);
        deps.broadcastStatus(ctx.tabId, state, progress);
      };

      const emitResult = (id: string, translated: string): void => {
        counters.done += 1;
        emit({ type: 'RESULT', id, translated });
        emit({ type: 'PROGRESS', id, status: 'done' });
        broadcastProgress('translating');
      };
      const emitError = (id: string, reason: string): void => {
        counters.failed += 1;
        emit({ type: 'ERROR', id, reason });
        emit({ type: 'PROGRESS', id, status: 'failed' });
        broadcastProgress('translating');
      };
      const emitSkipped = (id: string): void => {
        emit({ type: 'PROGRESS', id, status: 'skipped' });
      };

      /** 幂等写缓存（架构 4.6：每段成功即写）。失败吞掉——缓存是优化项，不应让翻译失败。 */
      const writeCache = (source: string, translated: string): void => {
        const key = deps.cache.cacheKey(source, ctx.engineId, fingerprint, ctx.targetLang);
        const entry: CacheEntry = {
          cacheKey: key,
          source,
          translated,
          engineId: ctx.engineId,
          promptFingerprint: fingerprint,
          targetLang: ctx.targetLang,
          createdAt: nowMs(),
          hitCount: 0,
          ...(ctx.sourceUrl !== undefined ? { sourceUrl: ctx.sourceUrl } : {}),
        };
        void deps.cache.set(entry).catch(() => {});
      };

      // ── 1. 查缓存：命中段直接回填 RESULT，剩余入队 ─────────────────────
      broadcastProgress('translating');
      const keys = items.map((it) => deps.cache.cacheKey(it.text, ctx.engineId, fingerprint, ctx.targetLang));
      const cached = await deps.cache.getMany(keys);

      const misses: Item[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const hit = cached.get(keys[i] ?? '');
        if (hit) {
          // 命中：直接回填，不发请求（核心契约：缓存命中段不发请求）。
          emitResult(item.id, hit.translated);
        } else {
          misses.push(item);
          emit({ type: 'PROGRESS', id: item.id, status: 'pending' });
        }
      }

      // ── 2. 打包切批（架构 4.5）──────────────────────────────────────────
      const batches = deps.packer.pack(misses, ctx.budget);

      // ── 内部：单批调度（acquire → withRetry(engine) → 解析/对齐/降级） ───
      async function callEngine(batch: Batch): Promise<string> {
        const userMessage = deps.protocol.buildUserMessage(batch.items);
        // withRetry 仅包网络层（429/5xx/退避）。AbortError 必须直抛不重试（契约）。
        return deps.retry
          .withRetry(
            () =>
              ctx.engine
                .translate({
                  systemPrompt,
                  userMessage,
                  targetLang: ctx.targetLang,
                  jsonMode: true,
                  signal: abort.signal,
                })
                .then((r) => r.content),
            { maxRetries: ctx.scheduling.maxRetries },
          );
      }

      async function scheduleBatch(batch: Batch, level: DegradeLevel): Promise<void> {
        // 入口与出队后双检 abort，避免取消后还发请求。
        if (abort.signal.aborted) {
          for (const it of batch.items) emitSkipped(it.id);
          emit({ type: 'BATCH_DONE', batchId: batch.id });
          return;
        }
        await deps.scheduler.acquire(batch.tokenEstimate);
        try {
          if (abort.signal.aborted) {
            for (const it of batch.items) emitSkipped(it.id);
            return;
          }
          for (const it of batch.items) emit({ type: 'PROGRESS', id: it.id, status: 'translating' });

          // ── 智能体模式路径（P1-1）：委托 agentRunner 跑 agent 尝试 + 基础模式回退 ──
          // 仅 mode==='agent' 且注入了 agentRunner 时启用；否则走下方基础路径（零回归）。
          if (ctx.mode === 'agent' && deps.agentRunner) {
            try {
              const outcome = await deps.agentRunner.run(batch, ctx, abort.signal);
              if (abort.signal.aborted) {
                for (const it of batch.items) emitSkipped(it.id);
                return;
              }
              for (const it of batch.items) {
                const t = outcome.translated.get(it.id);
                if (t !== undefined) {
                  writeCache(it.text, t);
                  emitResult(it.id, t);
                } else {
                  emitError(
                    it.id,
                    outcome.fallbackReason
                      ? `agent fallback (${outcome.fallbackReason}) exhausted`
                      : 'no translation',
                  );
                }
              }
            } catch (err) {
              if (isAbortError(err) || abort.signal.aborted) {
                for (const it of batch.items) emitSkipped(it.id);
                return;
              }
              // 引擎错（非中止，如重试耗尽 / context length）→ 标记该批段失败，不阻塞其他批。
              const reason = err instanceof Error ? err.message : String(err);
              for (const it of batch.items) emitError(it.id, reason);
            }
            return;
          }

          // ── 流式路径（P1-2 / TRA-17）：基础模式 + 引擎支持 translateStream 时启用 ──
          // 逐 delta 喂 StreamingBatchParser，按 id 对齐还原 → emit STREAM_CHUNK 边出边显。
          // 流结束用完整原文走 handleResult（与整批同源：对齐/缺段重发/降级/缓存），保证
          // 「流式失败/中断降级为非流式整批」与「幂等可续传」契约。失败则落到下方 callEngine。
          if (ctx.streaming && ctx.mode !== 'agent' && isStreamingEngine(ctx.engine as unknown)) {
            const sengine = ctx.engine as unknown as StreamingEngine;
            let streamedOk = false;
            try {
              const parser = new StreamingBatchParser();
              const userMessage = deps.protocol.buildUserMessage(batch.items);
              const full = await consumeStreamById(
                sengine,
                { systemPrompt, userMessage, targetLang: ctx.targetLang, jsonMode: true, signal: abort.signal },
                parser,
                (id, delta) => {
                  if (abort.signal.aborted || disconnected) return;
                  emit({ type: 'STREAM_CHUNK', id, chunk: delta });
                },
              );
              if (abort.signal.aborted) {
                for (const it of batch.items) emitSkipped(it.id);
                return;
              }
              await handleResult(batch, full, level);
              streamedOk = true;
            } catch (err) {
              if (isAbortError(err) || abort.signal.aborted) {
                for (const it of batch.items) emitSkipped(it.id);
                return;
              }
              // 流式失败（网络/解析中断）→ 降级非流式整批：落到下方 callEngine 路径。
              // 已 emit 的 STREAM_CHUNK 会被最终 RESULT(setText) 覆盖修正，不重复/不丢段。
            }
            if (streamedOk) return;
          }

          const raw = await callEngine(batch);
          if (abort.signal.aborted) {
            for (const it of batch.items) emitSkipped(it.id);
            return;
          }
          await handleResult(batch, raw, level);
        } catch (err) {
          if (isAbortError(err) || abort.signal.aborted) {
            for (const it of batch.items) emitSkipped(it.id);
            return;
          }
          // 引擎抛错（非可重试 4xx / 重试耗尽 / context-length 等）→ 走降级链，
          // 缩批可能规避 context length error（架构 9）。
          await degrade(batch, level, err instanceof Error ? err.message : String(err));
        } finally {
          deps.scheduler.release(batch.tokenEstimate);
          emit({ type: 'BATCH_DONE', batchId: batch.id });
        }
      }

      /** 解析 + 对齐 + 分支（架构 4.6）。 */
      async function handleResult(batch: Batch, raw: string, level: DegradeLevel): Promise<void> {
        const parsed = deps.protocol.parseResponse(raw, batch);
        if (!parsed.ok) {
          // 整批 parse 失败 → 降级拆小批。
          await degrade(batch, level, 'parse_error');
          return;
        }
        const { translated, missing } = deps.protocol.alignByIds(parsed.data, batch);

        // 已对齐段：写缓存 + 回填 RESULT。
        for (const it of batch.items) {
          const t = translated.get(it.id);
          if (t !== undefined) {
            writeCache(it.text, t);
            emitResult(it.id, t);
          }
        }

        if (missing.length === 0) return;

        // 部分对齐：缺失段单独成批重发（1 段一批），不重翻已对齐段（核心契约）。
        // 重发批固定 'single' 层级：单段批对齐几乎必成，若仍缺则该段判失败，避免无限递归。
        const resendItems = batch.items.filter((it) => missing.includes(it.id));
        await Promise.all(
          resendItems.map((it) => scheduleBatch(makeBatch(ctx.tabId, [it]), 'single')),
        );
      }

      /** 降级链（架构 4.6）：full→degradeBatch→degraded；degraded→单段→single；single→ERROR。 */
      async function degrade(batch: Batch, level: DegradeLevel, reason: string): Promise<void> {
        if (level === 'full') {
          const subs = deps.protocol.degradeBatch(batch);
          await Promise.all(subs.map((s) => scheduleBatch(s, 'degraded')));
          return;
        }
        if (level === 'degraded') {
          // 再失败 → 逐段单发（回退到沉浸式行为，仅容错路径）。
          await Promise.all(
            batch.items.map((it) => scheduleBatch(makeBatch(ctx.tabId, [it]), 'single')),
          );
          return;
        }
        // single 仍失败 → 标记该段翻译失败，不阻塞其他段。
        for (const it of batch.items) emitError(it.id, reason);
      }

      // ── 3. 调度执行（并发 gate + 令牌桶 + 退避，架构 5）──────────────────
      // Promise.all 启动全部批，scheduler.acquire 内部 gate 保证在途 ≤ maxConcurrent。
      try {
        await Promise.all(batches.map((b) => scheduleBatch(b, 'full')));
      } finally {
        tabControllers.delete(ctx.tabId);
      }

      // ── 4. 收尾广播 ─────────────────────────────────────────────────────
      if (cancelled || abort.signal.aborted) {
        // 用户取消或 port 断开：未完成段已标 skipped，整体 paused。
        broadcastProgress('paused');
      } else if (counters.failed > 0 && counters.done === 0) {
        // 一段都没成功（如引擎彻底不可用）→ error 态供 UI 提示。
        broadcastProgress('error');
      } else {
        deps.broadcastStatus(ctx.tabId, 'done', 1);
      }
    },
  };
}
