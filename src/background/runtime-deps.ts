/**
 * 运行时依赖装配 —— 把 Stage 2 真实模块接成 orchestrator/port-server 依赖的接缝。
 *
 * 本文件是 Stage 3 集成（P0-12）的唯一接缝点：Stage 2 各模块（P0-3/4/5/6/8/9）已合并主干，
 * 这里把它们各自的真实实现适配成 orchestrator 声明的 DI 接口契约
 * （Protocol / Packer / Scheduler / Retry / Cache）—— 接口签名见 orchestrator.ts。
 *
 * ── 适配必要性 ────────────────────────────────────────────────────────────
 * Stage 2 模块按各自 issue 的验收契约实现（多为纯函数 / 类导出），与 orchestrator 为隔离
 * 并行开发而自建的 DI 接口在形状上有差异（例：protocol 是一组纯函数而非对象；cacheKey 是
 * 异步 sha256 而 orchestrator 同步取 key）。本文件用薄包装层对齐签名，**不改 Stage 2 模块
 * 与 orchestrator 二者其一的既有契约**，保证各自的单测仍独立通过。
 *
 * ── cacheKey 同步化取舍 ───────────────────────────────────────────────────
 * orchestrator 的 Cache.cacheKey 是同步的（构建 key 后立刻 await getMany），而 cache-key.ts
 * 用 Web Crypto sha256（异步）。让 orchestrator 改异步会破坏其 7 项集成测试的契约 mock。
 * 此处用确定性 FNV-1a 64bit 哈希做同步 key —— 输入仍是 (source+engineId+fingerprint+targetLang)，
 * 与 sha256 同输入、同区分度，仅非加密强度；缓存 key 只需确定性 + 低碰撞，FNV-1a 64bit 足够
 * （碰撞概率远低于单库 1e8 条目级）。promptFingerprint（protocol djb2）+ 源文本提供区分度。
 * 跨 SW 卸载 / 重启：同输入产出同 key，幂等命中行为与 sha256 等价。
 */
import type { AppConfig, EngineConfig, TabTranslationState } from '../shared/types';
import type {
  AgentBatchRunner,
  Cache,
  Engine,
  Orchestrator,
  Packer,
  Protocol,
  Retry,
  Scheduler,
  TokenBudget,
  TranslateContext,
} from './orchestrator';
import { createOrchestrator } from './orchestrator';
import type { PortServerDeps } from './port-server';

// Stage 2 真实模块
import {
  alignByIds as protocolAlignByIds,
  buildSystemPrompt,
  buildUserMessage,
  degradeBatch as protocolDegradeBatch,
  parseResponse as protocolParseResponse,
  promptFingerprint,
} from './batcher/protocol';
import { pack as packerPack } from './batcher/packer';
import type { Batch as PackerBatch } from './batcher/types';
import { estimateTokens } from './batcher/token-estimator';
import { ConcurrencyController } from './scheduler/concurrency-controller';
import { withRetry as schedulerWithRetry } from './scheduler/retry';
import { CacheStore, type CacheEntry as StoreCacheEntry } from './cache/cache-store';
import { syncCacheKey } from './cache/sync-cache-key';
import { createEngineRegistry } from './engines/registry';
import { loadConfig } from './config/config-store';
// P1-1 智能体模式
import { buildAgentSystemPrompt, agentPromptFingerprint } from './agent/prompt-builder';
import { runAgentBatch, type AgentEngine } from './agent/agent-mode';
import { resolveGlossary } from './agent/glossary';
import type { AgentPromptInput, GlossaryPair } from '../types/agent';

// ═══════════════════════════════════════════════════════════════════════════
// Stage 2 模块集合
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stage 2 全部模块的集合，已适配为 orchestrator DI 契约。
 * 由 getStage2Modules() 装配；background.ts 启动时调用一次。
 */
export interface Stage2Modules {
  protocol: Protocol;
  packer: Packer;
  scheduler: Scheduler;
  retry: Retry;
  cache: Cache;
  /** 按引擎 id 解析引擎实例（内部取 secret-store 明文 key，绝不外泄）。 */
  engineRegistry: { get(engineId: string): Engine | Promise<Engine> };
  /** 读取当前 AppConfig（storage.local `config` 键）。 */
  getConfig: () => Promise<AppConfig>;
  /** 进度广播给 popup（一次性 STATUS 消息）。 */
  broadcastStatus: (tabId: number, state: TabTranslationState, progress: number) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// 智能体模式：术语库查找表 + 提示词输入解析（P1-1）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 术语库 id → pairs 的内存查找表。glossaries IDB store（架构 6.1）尚未落地（UI 编辑器
 * 在 P1-3 接入），当前为空表 → 智能体模式不注入术语约束。store 落地后由 background.ts
 * 启动时调用 setGlossaryLookup 注入启用术语库的解析结果；prompt-builder / fingerprint
 * 同步读取此表，故指纹与提示词一致。
 */
let glossaryLookup: ReadonlyMap<string, GlossaryPair[]> = new Map();

/** 注入术语库查找表（glossary store 加载后由 background.ts 调用）。 */
export function setGlossaryLookup(lookup: ReadonlyMap<string, GlossaryPair[]>): void {
  glossaryLookup = lookup;
}

/**
 * 把 TranslateContext + AgentConfig 解析为纯提示词输入 AgentPromptInput：
 * glossaryIds → pairs（同步查内存表）、pageContext 透传。prompt-builder 与
 * agentPromptFingerprint 共用此函数，保证提示词与指纹同源。
 */
function toAgentPromptInput(ctx: TranslateContext): AgentPromptInput {
  const agent = ctx.agent;
  const input: AgentPromptInput = {
    targetLang: ctx.targetLang,
    sourceLang: ctx.sourceLang,
  };
  if (agent) {
    if (agent.systemPrompt) input.systemPrompt = agent.systemPrompt;
    if (agent.role) input.role = agent.role;
    input.stylePreset = agent.stylePreset;
    const pairs = resolveGlossary(agent.glossaryIds, glossaryLookup);
    if (pairs.length > 0) input.glossary = pairs;
  }
  if (ctx.pageContext) input.pageContext = ctx.pageContext;
  return input;
}

/**
 * 用 retry 包装引擎为 AgentEngine（runAgentBatch 消费）。runAgentBatch 自身不感知
 * 重试 —— 429/5xx 退避由 retry 层在每次 translate 调用上应用（架构 5.2）。
 */
function wrapEngineWithRetry(
  engine: Engine,
  retry: Retry,
  maxRetries: number,
  signal: AbortSignal,
): AgentEngine {
  return {
    async translate(req) {
      const res = await retry.withRetry(
        () => engine.translate({ ...req, signal }),
        { maxRetries },
      );
      return { content: res.content };
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 装配（纯函数，无外部依赖，可单测）
// ═══════════════════════════════════════════════════════════════════════════

/** 由引擎元数据 + 调度参数算出单批 token 预算（架构 4.5）。 */
export function computeBudget(engine: EngineConfig, scheduling: AppConfig['scheduling']): TokenBudget {
  const inputMax = Math.floor(engine.contextWindow * scheduling.batchTokenBudgetRatio);
  return { inputMax: Math.max(inputMax, 1) };
}

/** 把 Stage 2 模块接成 port-server 依赖（编排器 + buildContext）。 */
export function buildPortServerDeps(mods: Stage2Modules): PortServerDeps {
  // 智能体模式批量执行器（P1-1）：mode==='agent' 时由 orchestrator 委托。
  const agentRunner: AgentBatchRunner = {
    async run(batch, ctx, signal) {
      const engine = wrapEngineWithRetry(ctx.engine, mods.retry, ctx.scheduling.maxRetries, signal);
      const result = await runAgentBatch({
        items: batch.items,
        agent: toAgentPromptInput(ctx),
        targetLang: ctx.targetLang,
        engine,
        signal,
      });
      return {
        translated: result.translated,
        failedIds: result.failedIds,
        ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
      };
    },
  };

  const orchestrator: Orchestrator = createOrchestrator({
    protocol: mods.protocol,
    packer: mods.packer,
    scheduler: mods.scheduler,
    retry: mods.retry,
    cache: mods.cache,
    agentRunner,
    broadcastStatus: mods.broadcastStatus,
  });

  const buildContext = async (tabId: number, pageTitle?: string): Promise<TranslateContext> => {
    const config = await mods.getConfig();
    const engineCfg = config.engines[config.activeEngineId];
    if (!engineCfg) {
      throw new Error(`active engine "${config.activeEngineId}" not configured`);
    }
    const engine = await mods.engineRegistry.get(config.activeEngineId);
    const ctx: TranslateContext = {
      tabId,
      engine,
      engineId: engine.id,
      targetLang: config.targetLang,
      sourceLang: config.sourceLang,
      mode: config.mode,
      scheduling: config.scheduling,
      budget: computeBudget(engineCfg, config.scheduling),
      streaming: config.streaming.enabled,
      // 页面上下文开关（架构 §8 P1）：仅当 agent.pageContextEnabled 开启时，
      // orchestrator 才在打包前构建上下文。pageTitle 由 content 侧透传。
      pageContextEnabled: config.agent.pageContextEnabled,
      ...(pageTitle !== undefined ? { pageTitle } : {}),
    };
    if (config.mode === 'agent') ctx.agent = config.agent;
    return ctx;
  };

  return { orchestrator, buildContext };
}

// ═══════════════════════════════════════════════════════════════════════════
// 适配器：把 Stage 2 真实实现包装成 orchestrator DI 契约
// ═══════════════════════════════════════════════════════════════════════════

/** 同步确定性 cacheKey 已提取至 ./cache/sync-cache-key.ts，供 content 侧回写缓存共用。 */

/**
 * Protocol 适配器：protocol.ts 导出的是一组纯函数，这里聚合成 orchestrator 期望的对象。
 *
 * 签名对齐点：
 * - buildSystemPrompt / buildUserMessage / promptFingerprint：直接转发（PromptContext 字段兼容）。
 * - parseResponse：protocol 返回 {ok,items}，orchestrator 期望 {ok,data} —— 把 items 包回 {items} 信封作为 data。
 * - alignByIds：protocol 接受 TranslationItem[]，orchestrator 传 parsed.data（即上一步的信封）—— 适配为接受 unknown，内部解包。
 * - degradeBatch：protocol 产出无 tokenEstimate 的 Batch（batcher 类型），orchestrator 期望带 tokenEstimate —— 补算。
 */
function makeProtocol(): Protocol {
  return {
    buildSystemPrompt(ctx) {
      // 智能体模式用 prompt-builder 产出富提示词（角色/风格/术语/上下文 + 协议规则）；
      // 基础模式走 protocol.buildSystemPrompt（零回归），并注入 pageContext（架构 §8 P1）。
      if (ctx.mode === 'agent' && ctx.agent) {
        return buildAgentSystemPrompt(toAgentPromptInput(ctx));
      }
      return buildSystemPrompt({
        targetLang: ctx.targetLang,
        sourceLang: ctx.sourceLang,
        mode: ctx.mode,
        ...(ctx.pageContext ? { pageContext: ctx.pageContext } : {}),
      });
    },
    buildUserMessage(items) {
      return buildUserMessage(items);
    },
    fingerprint(ctx) {
      // 智能体模式指纹基于 agent 提示词（含角色/风格/术语/上下文）—— 换任一即不命中旧缓存。
      if (ctx.mode === 'agent' && ctx.agent) {
        return agentPromptFingerprint(toAgentPromptInput(ctx));
      }
      return promptFingerprint({
        targetLang: ctx.targetLang,
        sourceLang: ctx.sourceLang,
        mode: ctx.mode,
        ...(ctx.pageContext ? { pageContext: ctx.pageContext } : {}),
      });
    },
    parseResponse(raw, batch) {
      const outcome = protocolParseResponse(raw, batch);
      if (!outcome.ok) return { ok: false, error: 'parse_error' };
      // 把 items 包回 {items} 信封交给 alignByIds（适配层内部约定）。
      return { ok: true, data: { items: outcome.items } };
    },
    alignByIds(parsed, batch) {
      // orchestrator 传来的 parsed 是 parseResponse 产出的 data（{items} 信封）。
      const items = (parsed as { items?: unknown }).items;
      const arr = Array.isArray(items) ? items : [];
      const result = protocolAlignByIds(arr as Parameters<typeof protocolAlignByIds>[0], batch as unknown as Parameters<typeof protocolAlignByIds>[1]);
      // protocol AlignResult 多一个 extra 字段，orchestrator 只取 translated + missing。
      return { translated: result.translated, missing: result.missing };
    },
    degradeBatch(batch) {
      const subs = protocolDegradeBatch(batch as unknown as PackerBatch);
      // 补 tokenEstimate（orchestrator Batch 需要），用 packer.estimateTokens 估算。
      return subs.map((s) => ({
        id: s.id,
        items: s.items,
        tokenEstimate: s.items.reduce((sum, it) => sum + estimateTokens(it.text), 0),
      }));
    },
  };
}

/**
 * Packer 适配器：packer.pack 需要 systemPrompt 第三参（预扣 overhead），orchestrator 只传 2 参。
 * estimateTokens 在 token-estimator.ts，packer 模块未导出 —— 这里桥接。
 */
function makePacker(): Packer {
  return {
    estimateTokens(text) {
      // 无 provider 上下文，走保守字符比例估算（与架构 4.5 一致）。
      return estimateTokens(text);
    },
    pack(items, budget) {
      // orchestrator 不传 systemPrompt；packer 内部 overheadTokens('')=0，等价于不预扣 overhead。
      // 预算已由 computeBudget 按 ratio 折算，留有 headroom，可接受。
      const batches = packerPack(items, { inputMax: budget.inputMax }, '');
      return batches.map((b) => ({
        id: b.id,
        items: b.items,
        tokenEstimate: b.items.reduce((sum, it) => sum + estimateTokens(it.text), 0),
      }));
    },
  };
}

/**
 * Scheduler 适配器：ConcurrencyController 是有状态类，orchestrator 期望 acquire/release 函数对象。
 * - release(cost)：orchestrator 传 token 量，ConcurrencyController.release() 不接 cost（rate 预算按时间补桶）—— 忽略 cost。
 * - AIMD（recordSuccess/recordThrottle）orchestrator 不主动调；withRetry 的 onSuccess/onThrottle 钩子可接，
 *   但为保持最小改动、避免循环依赖，此处不接 AIMD（内存限速仍由 gate + 令牌桶保证）。
 */
function makeScheduler(maxConcurrent: number, rps: number, tpmLimit: number): Scheduler {
  const ctrl = new ConcurrencyController({ maxConcurrent, rps, tpmLimit });
  return {
    acquire(cost) {
      return ctrl.acquire(cost);
    },
    release(cost) {
      void cost;
      ctrl.release();
    },
  };
}

/** Retry 适配器：直接转发 withRetry，透传 maxRetries。 */
function makeRetry(): Retry {
  return {
    withRetry(fn, opts) {
      return schedulerWithRetry(fn, { maxRetries: opts?.maxRetries });
    },
  };
}

/**
 * Cache 适配器：CacheStore.getMany 返回数组，orchestrator 期望 Map；cacheKey 同步化（见文件头）。
 */
function makeCache(store: CacheStore): Cache {
  return {
    cacheKey(source, engineId, fingerprint, targetLang) {
      return syncCacheKey(source, engineId, fingerprint, targetLang);
    },
    async getMany(keys) {
      const arr = await store.getMany(keys);
      const m = new Map<string, StoreCacheEntry>();
      for (let i = 0; i < keys.length; i++) {
        const entry = arr[i];
        if (entry) m.set(keys[i]!, entry);
      }
      return m;
    },
    async set(entry) {
      await store.set(entry);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 装配入口：background.ts 调用
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 取 Stage 2 模块集合（已适配）。background.ts 启动时调用一次。
 * 单例缓存 CacheStore / ConcurrencyController（它们有内存态令牌桶 / IDB 连接，应复用）。
 */
export function getStage2Modules(): Stage2Modules {
  // CacheStore 单例：IDB 连接复用，避免每次翻译重开库。
  const cacheStore = new CacheStore();
  return {
    protocol: makeProtocol(),
    packer: makePacker(),
    // 调度参数用默认值（DEFAULT_SCHEDULING）；用户在 options 改后会触发 CONFIG_CHANGED →
    // SW 重载内存配置，但 ConcurrencyController 实例不重建（保持当前 SW 生命周期内稳定）。
    // 这是 MVP 取舍：maxConcurrent/RPS 在 SW 存活期内固定，下次 SW 重启用新值。
    scheduler: makeScheduler(3, 2, 0),
    retry: makeRetry(),
    cache: makeCache(cacheStore),
    engineRegistry: createEngineRegistry(),
    getConfig: () => loadConfig(),
    broadcastStatus: (tabId, state, progress) => {
      // background.ts 的 setTabTranslation 负责落内存 + 广播 STATUS；此处注入。
      // 为避免循环 import（background.ts → runtime-deps → background.ts），用动态查找。
      const mod = getBackgroundSetTabTranslation();
      if (mod) mod(tabId, state, progress);
    },
  };
}

/** 便捷装配：background.ts 入口调用。 */
export function initRuntimeOrchestrator(): PortServerDeps {
  return buildPortServerDeps(getStage2Modules());
}

// ── 避免循环 import 的 setTabTranslation 注入点 ─────────────────────────────
// background.ts 导出 setTabTranslation 并调用 registerSetTabTranslation 注册，
// runtime-deps 的 broadcastStatus 通过此句柄回写，避免 background ↔ runtime-deps 静态循环。
let setTabTranslationFn: ((tabId: number, state: TabTranslationState, progress: number) => void) | null = null;

/** background.ts 启动时注册其 setTabTranslation，供 orchestrator 广播进度。 */
export function registerSetTabTranslation(fn: (tabId: number, state: TabTranslationState, progress: number) => void): void {
  setTabTranslationFn = fn;
}

function getBackgroundSetTabTranslation(): ((tabId: number, state: TabTranslationState, progress: number) => void) | null {
  return setTabTranslationFn;
}
