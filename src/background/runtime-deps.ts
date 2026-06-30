/**
 * 运行时依赖装配 —— 把 Stage 2 真实模块接成 orchestrator/port-server 依赖的接缝。
 *
 * ★ 这是 Stage 3 集成的唯一接缝点。Stage 2（P0-3/4/5/6）合并到主干后，
 *    只需实现 `getStage2Modules()`（下方 TODO 列了每条 import 路径），整条
 *    翻译流水线即接通。在此之前它抛出明确错误（不静默失败）。
 *
 * 本文件不静态 import 任何 Stage 2 模块（它们尚未存在），因此独立编译通过；
 * Stage 2 实现必须满足 `src/background/orchestrator.ts` 中声明的 DI 接口契约
 * （Protocol / Packer / Scheduler / Retry / Cache / Engine）—— 那些接口签名
 * 与各 Stage 2 issue 的验收标准一一对应。
 */
import type { AppConfig, EngineConfig, TabTranslationState } from '../shared/types';
import type {
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

// ═══════════════════════════════════════════════════════════════════════════
// Stage 2 模块集合（待接入）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Stage 2 全部模块的集合。每项标注来源路径与所属 issue：
 *   - protocol / packer    ← src/background/batcher/{protocol,packer,token-estimator}.ts  (P0-4 / TRA-5)
 *   - scheduler / retry    ← src/background/scheduler/{concurrency-controller,retry}.ts    (P0-5 / TRA-6)
 *   - cache                ← src/background/cache/{cache-store,cache-key}.ts               (P0-6 / TRA-7)
 *   - engineRegistry       ← src/background/engines/registry.ts                            (P0-3 / TRA-4)
 *   - getConfig            ← src/background/config/config-store.ts                         (P0-11 / TRA-12)
 *   - broadcastStatus      ← chrome.runtime.sendMessage({type:'STATUS', tabId, state, progress})
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
// 装配（纯函数，无外部依赖，可单测）
// ═══════════════════════════════════════════════════════════════════════════

/** 由引擎元数据 + 调度参数算出单批 token 预算（架构 4.5）。 */
export function computeBudget(engine: EngineConfig, scheduling: AppConfig['scheduling']): TokenBudget {
  const inputMax = Math.floor(engine.contextWindow * scheduling.batchTokenBudgetRatio);
  return { inputMax: Math.max(inputMax, 1) };
}

/** 把 Stage 2 模块接成 port-server 依赖（编排器 + buildContext）。 */
export function buildPortServerDeps(mods: Stage2Modules): PortServerDeps {
  const orchestrator: Orchestrator = createOrchestrator({
    protocol: mods.protocol,
    packer: mods.packer,
    scheduler: mods.scheduler,
    retry: mods.retry,
    cache: mods.cache,
    broadcastStatus: mods.broadcastStatus,
  });

  const buildContext = async (tabId: number): Promise<TranslateContext> => {
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
    };
    if (config.mode === 'agent') ctx.agent = config.agent;
    return ctx;
  };

  return { orchestrator, buildContext };
}

// ═══════════════════════════════════════════════════════════════════════════
// 接缝：待 Stage 2 合并后实现
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 取 Stage 2 模块集合。Stage 2（P0-3/4/5/6）合并主干后，把下列 import 取消注释、
 * 替换抛错为真实装配即可。每条路径与上方 Stage2Modules 注释一一对应。
 *
 *   import { protocol, buildSystemPrompt, ... } from './batcher/protocol';
 *   import { packer } from './batcher/packer';
 *   import { concurrencyController } from './scheduler/concurrency-controller';
 *   import { withRetry } from './scheduler/retry';
 *   import { cacheStore, cacheKey } from './cache/cache-store';  // + cache-key
 *   import { engineRegistry } from './engines/registry';
 *   import { getConfig } from './config/config-store';           // P0-11
 *
 * 具体导出名以 Stage 2 各 issue 实现为准；只要满足 orchestrator.ts 的 DI 接口
 * 契约即可在此处适配（必要时薄包装一层对齐签名）。
 */
export function getStage2Modules(): Stage2Modules {
  throw new Error(
    '[bt] orchestrator 尚未接入 Stage 2：P0-3(engines)/P0-4(batcher)/P0-5(scheduler)/P0-6(cache) 合并后，' +
      '在 runtime-deps.getStage2Modules() 装配真实模块（见文件顶部 import 清单）。',
  );
}

/** 便捷装配：background.ts 入口调用。Stage 2 未接入前抛错（见 getStage2Modules）。 */
export function initRuntimeOrchestrator(): PortServerDeps {
  return buildPortServerDeps(getStage2Modules());
}
