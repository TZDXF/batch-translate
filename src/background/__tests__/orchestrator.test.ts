/**
 * orchestrator 集成测试（任务 P0-7 验收：mock 引擎/缓存/port，覆盖四条主路径 + 降级到失败）。
 *
 * 这里用「忠实于契约」的 mock 实现 Stage 2 依赖（protocol/packer/scheduler/retry/cache/engine），
 * 专门验证编排器自身的调度/对齐/降级/缓存/取消逻辑 —— 不依赖真实 Stage 2 模块。
 */
import { describe, expect, it } from 'vitest';
import type { TabTranslationState } from '../../shared/types';
import type { Item } from '../../shared/types';
import {
  createOrchestrator,
} from '../orchestrator';
import type {
  CacheEntry,
  Engine,
  EngineTranslateRequest,
  Orchestrator,
  OrchestratorDeps,
  OrchestratorPort,
  Packer,
  Protocol,
  TranslateContext,
} from '../orchestrator';
import type { SMToContentPortMessage } from '../../shared/messages';

// ═══════════════════════════════════════════════════════════════════════════
// Mock 工厂（忠实于 orchestrator 的 DI 契约）
// ═══════════════════════════════════════════════════════════════════════════

type Responder = (ids: string[], req: EngineTranslateRequest) => string | Promise<string>;

/** 构造批量协议 JSON 响应原文。 */
function jsonResponse(pairs: Array<[id: string, text: string]>): string {
  return JSON.stringify({ items: pairs.map(([id, text]) => ({ id, text })) });
}

function makeProtocol(): Protocol {
  return {
    buildSystemPrompt: (ctx) => `sys:${ctx.targetLang}`,
    buildUserMessage: (items) => JSON.stringify({ items }),
    fingerprint: (ctx) => `${ctx.mode}`,
    parseResponse: (raw): { ok: true; data: unknown } | { ok: false; error: 'parse_error' } => {
      try {
        return { ok: true, data: JSON.parse(raw) };
      } catch {
        return { ok: false, error: 'parse_error' };
      }
    },
    alignByIds: (parsed: unknown, batch) => {
      const obj = parsed as { items?: Array<{ id: string; text: string }> };
      const map = new Map<string, string>();
      if (Array.isArray(obj?.items)) {
        for (const it of obj.items) map.set(String(it.id), String(it.text));
      }
      const translated = new Map<string, string>();
      const missing: string[] = [];
      for (const it of batch.items) {
        const t = map.get(it.id);
        if (t !== undefined) translated.set(it.id, t);
        else missing.push(it.id);
      }
      return { translated, missing };
    },
    degradeBatch: (batch) => {
      // 拆两半（mock 的降级策略；真实策略见 P0-4，架构 4.6 20→4×5）
      const mid = Math.ceil(batch.items.length / 2);
      const halves = [batch.items.slice(0, mid), batch.items.slice(mid)].filter((g) => g.length > 0);
      return halves.map((g, i) => ({
        id: `${batch.id}-d${i + 1}`,
        items: g,
        tokenEstimate: g.reduce((s, it) => s + it.text.length, 0),
      }));
    },
  };
}

function makePacker(): Packer {
  return {
    estimateTokens: (text) => text.length,
    pack: (items) => [
      { id: 'bt-test-batch', items, tokenEstimate: items.reduce((s, it) => s + it.text.length, 0) },
    ],
  };
}

function makeScheduler() {
  let active = 0;
  let peak = 0;
  const acquireCalls: number[] = [];
  let releaseCount = 0;
  const impl = {
    async acquire(cost = 0) {
      acquireCalls.push(cost);
      active += 1;
      peak = Math.max(peak, active);
    },
    release(_cost = 0) {
      active -= 1;
      releaseCount += 1;
    },
  };
  // releaseCount 是闭包里的原始值，必须用 getter 暴露（直接做属性会是快照副本）。
  return { impl, acquireCalls, getReleaseCount: () => releaseCount, getPeak: () => peak };
}

function makeRetry() {
  const impl = { async withRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> { return fn(0); } };
  return { impl };
}

function makeCache(initial?: Map<string, CacheEntry>) {
  const store = new Map<string, CacheEntry>(initial ?? []);
  const impl = {
    cacheKey(source: string, engineId: string, fp: string, lang: string) {
      return `${engineId}|${fp}|${lang}|${source}`;
    },
    async getMany(keys: string[]) {
      const m = new Map<string, CacheEntry>();
      for (const k of keys) {
        const e = store.get(k);
        if (e) m.set(k, e);
      }
      return m;
    },
    async set(entry: CacheEntry) {
      store.set(entry.cacheKey, entry);
    },
  };
  return { impl, store };
}

function makeEngine(responder: Responder): { engine: Engine; calls: { ids: string[] }[] } {
  const calls: { ids: string[] }[] = [];
  const engine: Engine = {
    id: 'eng-1',
    provider: 'openai',
    async translate(req: EngineTranslateRequest) {
      const parsed = JSON.parse(req.userMessage) as { items: { id: string }[] };
      const ids = parsed.items.map((i) => i.id);
      calls.push({ ids });
      const content = await responder(ids, req);
      return { content };
    },
  };
  return { engine, calls };
}

const SCHEDULING = {
  maxConcurrent: 3,
  rps: 2,
  tpmLimit: 0,
  maxRetries: 5,
  itemsPerBatch: 20,
  batchTokenBudgetRatio: 0.7,
};

function makeCtx(engine: Engine, overrides: Partial<TranslateContext> = {}): TranslateContext {
  return {
    tabId: 1,
    engine,
    engineId: engine.id,
    targetLang: 'zh',
    sourceLang: 'auto',
    mode: 'basic',
    scheduling: SCHEDULING,
    budget: { inputMax: 4000 },
    streaming: false,
    ...overrides,
  };
}

function makePort(): { port: OrchestratorPort; messages: SMToContentPortMessage[] } {
  const messages: SMToContentPortMessage[] = [];
  const port: OrchestratorPort = { postMessage: (m) => { messages.push(m); } };
  return { port, messages };
}

interface Setup {
  orchestrator: Orchestrator;
  deps: OrchestratorDeps;
  cache: ReturnType<typeof makeCache>;
  sched: ReturnType<typeof makeScheduler>;
  statusCalls: Array<[number, TabTranslationState, number]>;
  engine: Engine;
  engineCalls: { ids: string[] }[];
}

function setup(responder: Responder, opts: { cacheInitial?: Map<string, CacheEntry> } = {}): Setup {
  const protocol = makeProtocol();
  const packer = makePacker();
  const sched = makeScheduler();
  const retry = makeRetry();
  const cache = makeCache(opts.cacheInitial);
  const statusCalls: Array<[number, TabTranslationState, number]> = [];
  const broadcastStatus = (tabId: number, state: TabTranslationState, progress: number) =>
    statusCalls.push([tabId, state, progress]);
  const { engine, calls } = makeEngine(responder);
  const deps: OrchestratorDeps = {
    protocol,
    packer,
    scheduler: sched.impl,
    retry: retry.impl,
    cache: cache.impl,
    broadcastStatus,
  };
  const orchestrator = createOrchestrator(deps);
  return { orchestrator, deps, cache, sched, statusCalls, engine, engineCalls: calls };
}

const items = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), text: `text${i + 1}` }));

const resultsOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'RESULT'; id: string; translated: string } => m.type === 'RESULT');
const errorsOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'ERROR'; id: string; reason: string } => m.type === 'ERROR');
const lastStatus = (s: Setup['statusCalls']) => s[s.length - 1];

const flush = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════════════════
// 测试
// ═══════════════════════════════════════════════════════════════════════════

describe('orchestrator translateBatch', () => {
  it('完整批成功：发一次请求，逐段回填 RESULT + 写缓存 + 广播 done', async () => {
    const s = setup((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(s.engine), port);

    // 只发一次引擎请求（3 段合一批）
    expect(s.engineCalls).toHaveLength(1);
    expect(s.engineCalls[0]?.ids).toEqual(['1', '2', '3']);
    // 三段全部回填
    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    expect(results.every((r) => r.translated.startsWith('译-'))).toBe(true);
    // 缓存写入 3 条（幂等）
    expect(s.cache.store.size).toBe(3);
    // 调度：1 次 acquire / 1 次 release，平衡
    expect(s.sched.acquireCalls).toHaveLength(1);
    expect(s.sched.getReleaseCount()).toBe(1);
    // 广播最终 done(1)
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
    // 不再有未完成控制
    expect(s.orchestrator.isActive(1)).toBe(false);
  });

  it('部分对齐：缺段单独成批重发，不重翻已命中段', async () => {
    // 整批(1..4) 只回 1,2；缺 3,4 → 重发单段批分别回 3、4
    const s = setup((ids) => {
      if (ids.length === 4) return jsonResponse([['1', '译-1'], ['2', '译-2']]);
      if (ids.includes('3')) return jsonResponse([['3', '译-3']]);
      return jsonResponse([['4', '译-4']]);
    });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(4), makeCtx(s.engine), port);

    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3', '4']);
    // 三次引擎调用：整批(1..4) → 单段3 → 单段4
    expect(s.engineCalls).toHaveLength(3);
    expect(s.engineCalls[0]?.ids).toEqual(['1', '2', '3', '4']);
    expect(s.engineCalls[1]?.ids).toEqual(['3']);
    expect(s.engineCalls[2]?.ids).toEqual(['4']);
    // ★ 核心契约：重发只翻缺段，已对齐段 1,2 不在重发请求里
    const resendIds = [...(s.engineCalls[1]?.ids ?? []), ...(s.engineCalls[2]?.ids ?? [])];
    expect(resendIds).not.toContain('1');
    expect(resendIds).not.toContain('2');
    // 全部 4 段都入了缓存（已对齐段在重发前就写缓存）
    expect(s.cache.store.size).toBe(4);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('整批 parse 失败 → degradeBatch 拆小批重试成功（不丢段）', async () => {
    // 整批(1..4) 返回无法解析的垃圾 → 拆两半 (1,2)(3,4) 各自成功
    const s = setup((ids) => {
      if (ids.length === 4) return 'this is {{{ not json';
      return jsonResponse(ids.map((id) => [id, `译-${id}`]));
    });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(4), makeCtx(s.engine), port);

    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3', '4']);
    // 3 次请求：整批(失败) + 2 个降级子批
    expect(s.engineCalls).toHaveLength(3);
    expect(s.engineCalls[0]?.ids).toEqual(['1', '2', '3', '4']);
    // 降级子批覆盖全部 4 段（两半）
    const subIds = new Set([...(s.engineCalls[1]?.ids ?? []), ...(s.engineCalls[2]?.ids ?? [])]);
    expect([...subIds].sort()).toEqual(['1', '2', '3', '4']);
    expect(s.cache.store.size).toBe(4);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('逐级降级到底：整批→拆批→单段 全失败 → 该段 ERROR，不阻塞（无 RESULT）', async () => {
    // 永远返回垃圾 → full 失败拆 2 半 → 每半失败拆单段 → 单段失败 → ERROR
    const s = setup(() => 'garbage{{{');
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(4), makeCtx(s.engine), port);

    const results = resultsOf(messages);
    const errors = errorsOf(messages);
    expect(results).toHaveLength(0);
    expect(errors.map((e) => e.id).sort()).toEqual(['1', '2', '3', '4']);
    // 请求链：1(整批) + 2(降级半批) + 4(单段) = 7
    expect(s.engineCalls).toHaveLength(7);
    // 全失败（done=0）→ 广播 error 态
    expect(lastStatus(s.statusCalls)).toEqual([1, 'error', expect.any(Number)]);
  });

  it('缓存命中：命中段不发请求，仅翻译 missing 段', async () => {
    const preKeys = new Map<string, CacheEntry>();
    // 预先用与 orchestrator 相同的 cacheKey 公式写入 1、2 的缓存
    const keyFor = (text: string) => `eng-1|basic|zh|${text}`; // engineId|fingerprint(mode)|lang|source
    preKeys.set(keyFor('text1'), {
      cacheKey: keyFor('text1'), source: 'text1', translated: '缓存-1',
      engineId: 'eng-1', promptFingerprint: 'basic', targetLang: 'zh', createdAt: 1, hitCount: 0,
    });
    preKeys.set(keyFor('text2'), {
      cacheKey: keyFor('text2'), source: 'text2', translated: '缓存-2',
      engineId: 'eng-1', promptFingerprint: 'basic', targetLang: 'zh', createdAt: 1, hitCount: 0,
    });

    const s = setup((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])), { cacheInitial: preKeys });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(s.engine), port);

    const results = resultsOf(messages);
    // 1、2 走缓存，3 走引擎
    const byId = new Map(results.map((r) => [r.id, r.translated]));
    expect(byId.get('1')).toBe('缓存-1');
    expect(byId.get('2')).toBe('缓存-2');
    expect(byId.get('3')).toBe('译-3');
    // ★ 只发一次请求，且只含 missing 段 3
    expect(s.engineCalls).toHaveLength(1);
    expect(s.engineCalls[0]?.ids).toEqual(['3']);
    expect(s.cache.store.size).toBe(3);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('CANCEL：中止在途请求，未完成段标 skipped，广播 paused，槽位释放平衡', async () => {
    let resolveEngine: (() => void) | undefined;
    const engineBlock = new Promise<void>((r) => { resolveEngine = r; });

    const s = setup((_ids, req) =>
      new Promise<string>((resolve, reject) => {
        const signal = req.signal;
        const onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        if (!signal || signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'));
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
        void engineBlock.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve('{"items":[]}');
        });
      }),
    );
    const { port, messages } = makePort();

    const p = s.orchestrator.translateBatch(items(2), makeCtx(s.engine), port);
    // 让编排器跑到引擎阻塞处
    await flush();
    expect(s.orchestrator.isActive(1)).toBe(true);

    s.orchestrator.cancel(1);
    resolveEngine?.();
    await p;

    // 取消后无 RESULT；未完成段标 skipped
    expect(resultsOf(messages)).toHaveLength(0);
    const skipped = messages.filter((m) => m.type === 'PROGRESS' && m.status === 'skipped');
    expect(skipped.map((m) => (m as { id: string }).id).sort()).toEqual(['1', '2']);
    // 广播 paused
    expect(lastStatus(s.statusCalls)?.[1]).toBe('paused');
    // 调度槽位释放平衡（acquire 与 release 次数相等，不留泄漏）
    expect(s.sched.acquireCalls).toHaveLength(s.sched.getReleaseCount());
    expect(s.orchestrator.isActive(1)).toBe(false);
  });

  it('空任务：直接 done，不调用引擎/调度', async () => {
    const s = setup(() => jsonResponse([]));
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch([], makeCtx(s.engine), port);

    expect(s.engineCalls).toHaveLength(0);
    expect(s.sched.acquireCalls).toHaveLength(0);
    expect(messages).toHaveLength(0);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 智能体模式路径（P1-1）：mode==='agent' 且注入 agentRunner 时委托回退决策
// ═══════════════════════════════════════════════════════════════════════════

import type { AgentBatchRunner, AgentBatchOutcome } from '../orchestrator';

function setupWithAgent(
  agentRunner: AgentBatchRunner,
  responder: Responder = () => jsonResponse([]),
): Setup & { agentCalls: number } {
  const protocol = makeProtocol();
  const packer = makePacker();
  const sched = makeScheduler();
  const retry = makeRetry();
  const cache = makeCache();
  const statusCalls: Array<[number, TabTranslationState, number]> = [];
  const broadcastStatus = (tabId: number, state: TabTranslationState, progress: number) =>
    statusCalls.push([tabId, state, progress]);
  const { engine, calls } = makeEngine(responder);
  const deps: OrchestratorDeps = {
    protocol,
    packer,
    scheduler: sched.impl,
    retry: retry.impl,
    cache: cache.impl,
    agentRunner,
    broadcastStatus,
  };
  const orchestrator = createOrchestrator(deps);
  return { orchestrator, deps, cache, sched, statusCalls, engine, engineCalls: calls, agentCalls: 0 };
}

describe('orchestrator agent-mode path (P1-1)', () => {
  it('agent 全量成功：走 agentRunner，不调引擎，逐段回填 + 写缓存 + done', async () => {
    const runner: AgentBatchRunner = {
      async run(batch): Promise<AgentBatchOutcome> {
        return {
          translated: new Map(batch.items.map((it) => [it.id, `译-${it.id}`])),
          failedIds: [],
        };
      },
    };
    const s = setupWithAgent(runner);
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(
      items(3),
      makeCtx(s.engine, { mode: 'agent' }),
      port,
    );

    // 引擎（基础路径）未被调用 —— agentRunner 接管
    expect(s.engineCalls).toHaveLength(0);
    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    expect(results.every((r) => r.translated.startsWith('译-'))).toBe(true);
    // 写缓存
    expect(s.cache.store.size).toBe(3);
    expect(errorsOf(messages)).toHaveLength(0);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('agent 部分失败：failedIds 段回 ERROR，成功段回 RESULT', async () => {
    const runner: AgentBatchRunner = {
      async run(batch): Promise<AgentBatchOutcome> {
        const translated = new Map<string, string>();
        const failedIds: string[] = [];
        for (const it of batch.items) {
          if (it.id === '2') failedIds.push(it.id);
          else translated.set(it.id, `译-${it.id}`);
        }
        return { translated, failedIds, fallbackReason: 'alignment_failure' };
      },
    };
    const s = setupWithAgent(runner);
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(
      items(3),
      makeCtx(s.engine, { mode: 'agent' }),
      port,
    );

    const results = resultsOf(messages).map((r) => r.id).sort();
    expect(results).toEqual(['1', '3']);
    const errors = errorsOf(messages);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.id).toBe('2');
    expect(errors[0]?.reason).toContain('alignment_failure');
  });

  it('agentRunner 抛错（非中止）：该批段回 ERROR，不阻塞收尾', async () => {
    const runner: AgentBatchRunner = {
      async run(): Promise<AgentBatchOutcome> {
        throw new Error('engine down');
      },
    };
    const s = setupWithAgent(runner);
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(
      items(2),
      makeCtx(s.engine, { mode: 'agent' }),
      port,
    );

    const errors = errorsOf(messages);
    expect(errors.map((e) => e.id).sort()).toEqual(['1', '2']);
    expect(errors.every((e) => e.reason === 'engine down')).toBe(true);
    // 调度槽位释放平衡
    expect(s.sched.acquireCalls).toHaveLength(s.sched.getReleaseCount());
    expect(s.orchestrator.isActive(1)).toBe(false);
  });

  it('零回归：mode==="basic" 时即使注入了 agentRunner 也走基础路径（调引擎）', async () => {
    let runnerCalled = 0;
    const runner: AgentBatchRunner = {
      async run(): Promise<AgentBatchOutcome> {
        runnerCalled++;
        return { translated: new Map(), failedIds: [] };
      },
    };
    const s = setupWithAgent(runner, (ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(s.engine), port); // mode 默认 basic

    expect(runnerCalled).toBe(0); // agentRunner 未启用
    expect(s.engineCalls).toHaveLength(1); // 走基础路径调引擎
    expect(resultsOf(messages).map((r) => r.id).sort()).toEqual(['1', '2', '3']);
  });
});
