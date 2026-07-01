/**
 * orchestrator 流式路径测试（P1-2 / TRA-17 验收）。
 *
 * 覆盖交付物 #5 的流式侧：
 *  - 流式成功：逐 chunk 发 STREAM_CHUNK（按 id 对齐）→ RESULT → 写缓存 → done。
 *  - 流式失败/中断 → 降级非流式整批（复用 callEngine）。
 *  - 流式 + 部分对齐 → 缺段单独重发（handleResult 路径不破坏）。
 *  - 并发不超限：多批流式同时跑，在途峰值 ≤ maxConcurrent（遵守 P0-5 控制器）。
 *  - 流式开关关闭：无 STREAM_CHUNK，行为与 P0 整批一致（零回归）。
 *
 * 用「忠实于 DI 契约」的 mock 引擎（同时实现 translate + translateStream）+ mock 依赖。
 */
import { describe, expect, it } from 'vitest';
import type { TabTranslationState } from '../../shared/types';
import type { Item } from '../../shared/types';
import { createOrchestrator } from '../orchestrator';
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
import type { EngineStreamEvent, StreamingEngine } from '../engines/stream-adapter';
import type { SMToContentPortMessage } from '../../shared/messages';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

/** 把一段完整 JSON 切成 delta 序列（模拟 SSE）。 */
function chunked(json: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size));
  return out;
}

function jsonResponse(pairs: Array<[id: string, text: string]>): string {
  return JSON.stringify({ items: pairs.map(([id, text]) => ({ id, text })) });
}

/** ids → 完整 JSON；流式按 chunkSize 切片。 */
function makeStreamingEngine(
  respond: (ids: string[]) => string,
  opts: { chunkSize?: number; failStream?: boolean; failNonStream?: boolean } = {},
): Engine & StreamingEngine & { streamCalls: number; translateCalls: number } {
  const chunkSize = opts.chunkSize ?? 8;
  let streamCalls = 0;
  let translateCalls = 0;
  return {
    id: 'eng-1',
    provider: 'openai',
    async translate(req: EngineTranslateRequest) {
      translateCalls++;
      if (opts.failNonStream) throw new Error('non-stream engine down');
      const ids = (JSON.parse(req.userMessage) as { items: { id: string }[] }).items.map((i) => i.id);
      return { content: respond(ids) };
    },
    async *translateStream(req: EngineTranslateRequest): AsyncGenerator<EngineStreamEvent, void, unknown> {
      streamCalls++;
      if (opts.failStream) throw new Error('stream down');
      const ids = (JSON.parse(req.userMessage) as { items: { id: string }[] }).items.map((i) => i.id);
      const full = respond(ids);
      for (const c of chunked(full, chunkSize)) yield { type: 'delta', content: c };
      yield { type: 'done', content: full };
    },
    get streamCalls() {
      return streamCalls;
    },
    get translateCalls() {
      return translateCalls;
    },
  } as Engine & StreamingEngine & { streamCalls: number; translateCalls: number };
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
      if (Array.isArray(obj?.items)) for (const it of obj.items) map.set(String(it.id), String(it.text));
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
      // 拆单段（简化），供降级路径用。
      return batch.items.map((it, i) => ({
        id: `${batch.id}-d${i}`,
        items: [it],
        tokenEstimate: it.text.length,
      }));
    },
  };
}

function makePacker(batchSize = 2): Packer {
  return {
    estimateTokens: (text) => text.length,
    pack: (items) => {
      const batches = [];
      for (let i = 0; i < items.length; i += batchSize) {
        const slice = items.slice(i, i + batchSize);
        batches.push({
          id: `bt-batch-${i}`,
          items: slice,
          tokenEstimate: slice.reduce((s, it) => s + it.text.length, 0),
        });
      }
      return batches;
    },
  };
}

/** 真正会 gate 的 scheduler（信号量），跟踪峰值。 */
function makeGatingScheduler(maxConcurrent: number) {
  let active = 0;
  let peak = 0;
  const waiters: Array<() => void> = [];
  let releaseCount = 0;
  const impl = {
    async acquire() {
      if (active >= maxConcurrent) {
        await new Promise<void>((r) => waiters.push(r));
      }
      active++;
      peak = Math.max(peak, active);
    },
    release() {
      active--;
      releaseCount++;
      const next = waiters.shift();
      if (next) next();
    },
  };
  return { impl, getPeak: () => peak, getReleaseCount: () => releaseCount };
}

function makeRetry() {
  const impl = {
    async withRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
      return fn(0);
    },
  };
  return { impl };
}

function makeCache() {
  const store = new Map<string, CacheEntry>();
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

const SCHEDULING = {
  maxConcurrent: 3,
  rps: 2,
  tpmLimit: 0,
  maxRetries: 5,
  itemsPerBatch: 20,
  batchTokenBudgetRatio: 0.7,
};

function makeCtx(
  engine: Engine & StreamingEngine,
  overrides: Partial<TranslateContext> = {},
): TranslateContext {
  return {
    tabId: 1,
    engine,
    engineId: engine.id,
    targetLang: 'zh',
    sourceLang: 'auto',
    mode: 'basic',
    scheduling: SCHEDULING,
    budget: { inputMax: 4000 },
    streaming: true,
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
  cache: ReturnType<typeof makeCache>;
  sched: ReturnType<typeof makeGatingScheduler>;
  statusCalls: Array<[number, TabTranslationState, number]>;
}

function setup(engine: Engine & StreamingEngine, opts: { maxConcurrent?: number; batchSize?: number } = {}): Setup & { engine: Engine & StreamingEngine } {
  const protocol = makeProtocol();
  const packer = makePacker(opts.batchSize ?? 2);
  const sched = makeGatingScheduler(opts.maxConcurrent ?? 3);
  const retry = makeRetry();
  const cache = makeCache();
  const statusCalls: Array<[number, TabTranslationState, number]> = [];
  const broadcastStatus = (tabId: number, state: TabTranslationState, progress: number) =>
    statusCalls.push([tabId, state, progress]);
  const deps: OrchestratorDeps = {
    protocol,
    packer,
    scheduler: sched.impl,
    retry: retry.impl,
    cache: cache.impl,
    broadcastStatus,
  };
  const orchestrator = createOrchestrator(deps);
  return { orchestrator, cache, sched, statusCalls, engine };
}

const items = (n: number): Item[] =>
  Array.from({ length: n }, (_, i) => ({ id: String(i + 1), text: `text${i + 1}` }));

const chunksOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'STREAM_CHUNK'; id: string; chunk: string } => m.type === 'STREAM_CHUNK');
const resultsOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'RESULT'; id: string; translated: string } => m.type === 'RESULT');
const lastStatus = (s: Setup['statusCalls']) => s[s.length - 1];

// reassemble STREAM_CHUNK per id
const reassembleChunks = (chunks: { id: string; chunk: string }[]): Record<string, string> => {
  const m: Record<string, string> = {};
  for (const c of chunks) m[c.id] = (m[c.id] ?? '') + c.chunk;
  return m;
};

// ── 测试 ───────────────────────────────────────────────────────────────────

describe('orchestrator 流式路径 (P1-2)', () => {
  it('流式成功：逐 id 发 STREAM_CHUNK → RESULT → 写缓存 → done', async () => {
    const engine = makeStreamingEngine((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    const s = setup(engine, { batchSize: 10 });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(engine), port);

    // 走流式（streamCalls=1），未走非流式回退。
    expect(engine.streamCalls).toBe(1);
    expect(engine.translateCalls).toBe(0);
    // STREAM_CHUNK 按 id 还原出完整译文。
    const chunks = chunksOf(messages);
    expect(reassembleChunks(chunks)).toEqual({ '1': '译-1', '2': '译-2', '3': '译-3' });
    // 最终 RESULT 整段覆盖（与流式拼接一致）。
    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    expect(results.every((r) => r.translated.startsWith('译-'))).toBe(true);
    // 缓存写入 3 条（幂等）。
    expect(s.cache.store.size).toBe(3);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('流式失败 → 降级非流式整批：translateStream 抛错后走 callEngine 成功', async () => {
    const engine = makeStreamingEngine(
      (ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])),
      { failStream: true },
    );
    const s = setup(engine, { batchSize: 10 });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(engine), port);

    // 流式试了一次（失败），非流式回退成功。
    expect(engine.streamCalls).toBe(1);
    expect(engine.translateCalls).toBe(1);
    // 无 STREAM_CHUNK（流式即失败，未吐 delta）。
    expect(chunksOf(messages)).toHaveLength(0);
    // RESULT 来自非流式回填。
    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    expect(s.cache.store.size).toBe(3);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('流式 + 部分对齐：缺段经 handleResult 单独重发（不重翻已对齐段）', async () => {
    // 整批 4 段，流式只返回 1,2（缺 3,4）→ handleResult 触发缺段重发（单段，非流式回退）。
    let firstStream = true;
    const engine = makeStreamingEngine((ids) => {
      if (ids.length === 4 && firstStream) {
        firstStream = false;
        return jsonResponse([['1', '译-1'], ['2', '译-2']]);
      }
      return jsonResponse(ids.map((id) => [id, `译-${id}`]));
    });
    const s = setup(engine, { batchSize: 4 });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(4), makeCtx(engine), port);

    const results = resultsOf(messages);
    expect(results.map((r) => r.id).sort()).toEqual(['1', '2', '3', '4']);
    expect(s.cache.store.size).toBe(4);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('并发不超限：多批流式同时跑，在途峰值 ≤ maxConcurrent', async () => {
    // 6 段，batchSize=2 → 3 批；maxConcurrent=2；流式引擎无人工延迟，但 acquire/release 仍 gate。
    const engine = makeStreamingEngine((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    const s = setup(engine, { maxConcurrent: 2, batchSize: 2 });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(6), makeCtx(engine), port);

    expect(resultsOf(messages).map((r) => r.id).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(s.sched.getPeak()).toBeLessThanOrEqual(2);
    // 槽位释放平衡。
    expect(s.sched.getReleaseCount()).toBe(3);
  });

  it('零回归：streaming=false 时不走流式，无 STREAM_CHUNK，走整批 callEngine', async () => {
    const engine = makeStreamingEngine((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    const s = setup(engine, { batchSize: 10 });
    const { port, messages } = makePort();

    await s.orchestrator.translateBatch(items(3), makeCtx(engine, { streaming: false }), port);

    expect(engine.streamCalls).toBe(0);
    expect(engine.translateCalls).toBe(1);
    expect(chunksOf(messages)).toHaveLength(0);
    expect(resultsOf(messages).map((r) => r.id).sort()).toEqual(['1', '2', '3']);
    expect(lastStatus(s.statusCalls)).toEqual([1, 'done', 1]);
  });

  it('CANCEL：流式中止 → 未完成段 skipped，广播 paused，槽位平衡', async () => {
    // 流式引擎在第一个 delta 后阻塞，等取消信号。
    let resolveBlock: (() => void) | undefined;
    const block = new Promise<void>((r) => { resolveBlock = r; });
    const engine = makeStreamingEngine((ids) => jsonResponse(ids.map((id) => [id, `译-${id}`])));
    // 覆盖 translateStream：先吐一个 delta，再等 block，期间监听 abort。
    const origStream = engine.translateStream.bind(engine);
    engine.translateStream = async function* (req: EngineTranslateRequest): AsyncGenerator<EngineStreamEvent, void, unknown> {
      const ids = (JSON.parse(req.userMessage) as { items: { id: string }[] }).items.map((i) => i.id);
      const full = jsonResponse(ids.map((id) => [id, `译-${id}`]));
      yield { type: 'delta', content: full.slice(0, 5) }; // 先吐一小段
      // 阻塞直到取消或放行。
      const onAbort = () => {
        if (req.signal?.aborted) resolveBlock?.();
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      if (req.signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
      await block;
      req.signal?.removeEventListener('abort', onAbort);
      if (req.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      yield { type: 'delta', content: full.slice(5) };
      yield { type: 'done', content: full };
    };
    void origStream;
    const s = setup(engine, { batchSize: 4 });
    const { port, messages } = makePort();

    const p = s.orchestrator.translateBatch(items(2), makeCtx(engine), port);
    // 让编排器跑到流式阻塞处。
    await new Promise((r) => setTimeout(r, 10));
    expect(s.orchestrator.isActive(1)).toBe(true);

    s.orchestrator.cancel(1);
    resolveBlock?.();
    await p;

    expect(resultsOf(messages)).toHaveLength(0);
    const skipped = messages.filter((m) => m.type === 'PROGRESS' && m.status === 'skipped');
    expect(skipped.map((m) => (m as { id: string }).id).sort()).toEqual(['1', '2']);
    expect(lastStatus(s.statusCalls)?.[1]).toBe('paused');
    expect(s.orchestrator.isActive(1)).toBe(false);
  });
});
