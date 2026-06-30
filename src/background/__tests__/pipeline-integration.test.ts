/**
 * 流水线集成测试（P0-12 / TRA-13 收尾）：用真实 Stage 2 模块（protocol/packer/scheduler/
 * retry/cache/engines）装配 orchestrator（经 runtime-deps 适配层），mock 引擎返回 JSON，
 * 验证整条翻译流水线的差异化点：
 *  - 批量合并：多段进，一次请求出（请求数 << 段落数）。
 *  - id 对齐：返回 items 一一对齐回输入。
 *  - 缓存命中：同输入二次翻译请求数为 0（命中段不发请求）。
 *  - 并发不超 maxConcurrent：mock 慢响应，断言在途峰值 ≤ 上限。
 *  - 部分失败重发：缺段单独成批重发，不重翻已对齐段。
 *
 * 这是对「整条流水线」的端到端验证（区别于 orchestrator.test.ts 用 mock 依赖验证编排器自身）。
 * 用 fake-indexeddb 提供真实 IndexedDB（vitest.setup 已注入）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOrchestrator } from '../orchestrator';
import type { SMToContentPortMessage } from '../../shared/messages';
import type { Item } from '../../shared/types';
import type { OrchestratorDeps, OrchestratorPort, TranslateContext } from '../orchestrator';
import { getStage2Modules, computeBudget } from '../runtime-deps';
import type { AppConfig, EngineConfig } from '../../shared/types';

// ── fake-indexeddb 已在 vitest.setup 注入；runtime-deps 的 CacheStore 走真实 idb ──

/** mock 引擎：记录每次请求的 items，按 responder 返回 content。 */
function makeMockEngine(
  responder: (ids: string[], userMessage: string, attempt: number) => string | Promise<string>,
  opts: { delayMs?: number } = {},
) {
  const calls: { ids: string[]; at: number }[] = [];
  let inFlight = 0;
  let peak = 0;
  const engine = {
    id: 'eng-mock',
    provider: 'openai-compatible',
    async translate(req: { userMessage: string; signal?: AbortSignal }) {
      const parsed = JSON.parse(req.userMessage) as { items: { id: string }[] };
      const ids = parsed.items.map((i) => i.id);
      calls.push({ ids, at: Date.now() });
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const content = await responder(ids, req.userMessage, calls.length - 1);
        return { content };
      } finally {
        inFlight--;
      }
    },
  };
  return { engine, calls, getPeak: () => peak, getInFlight: () => inFlight };
}

function makePort(): { port: OrchestratorPort; messages: SMToContentPortMessage[] } {
  const messages: SMToContentPortMessage[] = [];
  return { port: { postMessage: (m: SMToContentPortMessage) => messages.push(m) }, messages };
}

const SCHEDULING: AppConfig['scheduling'] = {
  maxConcurrent: 3,
  rps: 50, // 高 RPS 避免令牌桶干扰并发断言
  tpmLimit: 0,
  maxRetries: 3,
  itemsPerBatch: 20,
  batchTokenBudgetRatio: 0.7,
};

function makeCtx(engine: ReturnType<typeof makeMockEngine>['engine'], engineCfg: EngineConfig): TranslateContext {
  return {
    tabId: 1,
    engine,
    engineId: engine.id,
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'basic',
    scheduling: SCHEDULING,
    budget: computeBudget(engineCfg, SCHEDULING),
  };
}

const ENGINE_CFG: EngineConfig = {
  id: 'eng-mock',
  label: 'mock',
  provider: 'openai-compatible',
  baseUrl: 'http://mock/v1',
  model: 'mock',
  enabled: true,
  apiKeyRef: 'ref',
  contextWindow: 128_000,
  maxOutput: 4096,
};

/** 装配真实 Stage 2 模块的 orchestrator（经 runtime-deps.getStage2Modules）。 */
function makeRealOrchestrator(): { deps: OrchestratorDeps; statusCalls: Array<[number, string, number]> } {
  const mods = getStage2Modules();
  const statusCalls: Array<[number, string, number]> = [];
  const deps: OrchestratorDeps = {
    protocol: mods.protocol,
    packer: mods.packer,
    scheduler: mods.scheduler,
    retry: mods.retry,
    cache: mods.cache,
    broadcastStatus: (tabId, state, progress) => statusCalls.push([tabId, state, progress]),
  };
  createOrchestrator(deps); // 触发装配（createOrchestrator 内部无副作用，仅建闭包）
  return { deps, statusCalls };
}

const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: `p${i + 1}`, text: `Sentence number ${i + 1} for testing.` }));

const resultsOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'RESULT'; id: string; translated: string } => m.type === 'RESULT');

const flush = () => new Promise((r) => setTimeout(r, 0));

// CacheStore 用真实 IndexedDB（fake-indexeddb），跨测试需清库避免命中串扰。
async function clearCache(): Promise<void> {
  // 重新建一个 CacheStore 清空（同 DB 名 batchtranslate-cache）。
  const { CacheStore } = await import('../cache/cache-store');
  const store = new CacheStore();
  await store.clear();
}

describe('翻译流水线集成（真实 Stage 2 + mock 引擎）', () => {
  afterEach(async () => {
    await clearCache();
  });

  it('批量合并：12 段进 1 次请求出，id 一一对齐，逐段回填 RESULT', async () => {
    const { deps } = makeRealOrchestrator();
    const mock = makeMockEngine((ids) =>
      JSON.stringify({ items: ids.map((id) => ({ id, text: `译文-${id}` })) }),
    );
    const { port, messages } = makePort();
    const orch = createOrchestrator(deps);

    await orch.translateBatch(items(12), makeCtx(mock.engine, ENGINE_CFG), port);

    // ★ 差异化点：12 段合并为 1 次请求（沉浸式每段一请求）。
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.ids).toHaveLength(12);
    // 12 段全部回填，id 对齐。
    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(items(12).map((i) => i.id).sort());
    expect(results.every((r) => r.translated.startsWith('译文-'))).toBe(true);
  });

  it('缓存命中：同输入二次翻译请求数为 0（命中段不发请求）', async () => {
    const { deps } = makeRealOrchestrator();
    const mock = makeMockEngine((ids) =>
      JSON.stringify({ items: ids.map((id) => ({ id, text: `译文-${id}` })) }),
    );
    const orch = createOrchestrator(deps);

    // 第一次：3 段全 miss → 1 次请求，写缓存。
    const p1 = makePort();
    await orch.translateBatch(items(3), makeCtx(mock.engine, ENGINE_CFG), p1.port);
    expect(mock.calls).toHaveLength(1);
    expect(p1.messages.filter((m) => m.type === 'RESULT')).toHaveLength(3);

    // 第二次：同输入同引擎同目标语 → 全命中缓存。
    mock.calls.length = 0;
    const p2 = makePort();
    await orch.translateBatch(items(3), makeCtx(mock.engine, ENGINE_CFG), p2.port);
    // ★ 核心契约：缓存命中段不发请求，请求数为 0。
    expect(mock.calls).toHaveLength(0);
    expect(p2.messages.filter((m) => m.type === 'RESULT')).toHaveLength(3);
  });

  it('并发不超 maxConcurrent：多批慢响应，在途峰值 ≤ 上限', async () => {
    const { deps } = makeRealOrchestrator();
    // 大输入 + 小预算 → 强制拆成多批；慢响应让在途可观测。
    const mock = makeMockEngine(
      (ids) => JSON.stringify({ items: ids.map((id) => ({ id, text: `译文-${id}` })) }),
      { delayMs: 40 },
    );
    const orch = createOrchestrator(deps);

    // 30 段，预算极小（inputMax=20 token）→ 强制拆成 ≥3 批。
    const ctx: TranslateContext = {
      ...makeCtx(mock.engine, ENGINE_CFG),
      budget: { inputMax: 20 },
    };
    const { port, messages } = makePort();
    await orch.translateBatch(items(30), ctx, port);

    // 全部回填。
    expect(resultsOf(messages)).toHaveLength(30);
    // ★ 差异化点：并发控制在途 ≤ maxConcurrent(3)。
    expect(mock.getPeak()).toBeLessThanOrEqual(SCHEDULING.maxConcurrent);
    expect(mock.getInFlight()).toBe(0); // 收尾后无在途
  }, 30000);

  it('部分失败重发：缺段单独成批重发，不重翻已对齐段', async () => {
    const { deps } = makeRealOrchestrator();
    // 整批(4 段)只回 2 段 → 缺 2 段单段重发各自回填。
    const mock = makeMockEngine((ids) => {
      if (ids.length === 4) return JSON.stringify({ items: [{ id: 'p1', text: '译-1' }, { id: 'p2', text: '译-2' }] });
      return JSON.stringify({ items: ids.map((id) => ({ id, text: `译-${id}` })) });
    });
    const orch = createOrchestrator(deps);
    const { port, messages } = makePort();

    await orch.translateBatch(items(4), makeCtx(mock.engine, ENGINE_CFG), port);

    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    // ★ 核心契约：整批 + 2 次单段重发 = 3 次请求；重发只含缺段 p3/p4，不含已对齐 p1/p2。
    expect(mock.calls).toHaveLength(3);
    const resendIds = [...(mock.calls[1]?.ids ?? []), ...(mock.calls[2]?.ids ?? [])];
    expect(resendIds).not.toContain('p1');
    expect(resendIds).not.toContain('p2');
  });

  it('CANCEL：中止在途请求，未完成段标 skipped，不泄漏并发槽', async () => {
    const { deps } = makeRealOrchestrator();
    let resolveEngine: (() => void) | undefined;
    const block = new Promise<void>((r) => {
      resolveEngine = r;
    });
    const mock = makeMockEngine(async (_ids, _um, _att) => {
      await block;
      return JSON.stringify({ items: [] });
    });
    const orch = createOrchestrator(deps);
    const { port, messages } = makePort();

    const p = orch.translateBatch(items(2), makeCtx(mock.engine, ENGINE_CFG), port);
    await flush();
    expect(orch.isActive(1)).toBe(true);

    orch.cancel(1);
    resolveEngine?.();
    await p;

    expect(resultsOf(messages)).toHaveLength(0);
    const skipped = messages.filter((m) => m.type === 'PROGRESS' && m.status === 'skipped');
    expect(skipped.map((m) => (m as { id: string }).id).sort()).toEqual(['p1', 'p2']);
    expect(orch.isActive(1)).toBe(false);
  });
});

// 抑制未用警告（vi 在未来 hook 扩展时用）。
void vi;
