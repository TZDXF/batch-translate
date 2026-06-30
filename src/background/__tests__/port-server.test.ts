/**
 * port-server 测试 —— 翻译 Port 长连接生命周期（架构 2.2 translate:<tabId>）。
 * 用 fake chrome runtime + fake port + spy orchestrator/buildContext 验证接线路径。
 */
import { describe, expect, it, vi } from 'vitest';
import { initPortServer } from '../port-server';
import type { ChromeRuntimeLike, ChromeRuntimePort } from '../port-server';
import type { Engine, Orchestrator, TranslateContext } from '../orchestrator';

// ── fake chrome runtime + port ─────────────────────────────────────────────

function makeFakeRuntime(): {
  runtime: ChromeRuntimeLike;
  fireConnect: (port: ChromeRuntimePort) => void;
} {
  let listener: ((p: ChromeRuntimePort) => void) | undefined;
  const runtime: ChromeRuntimeLike = {
    runtime: { onConnect: { addListener: (fn) => { listener = fn; } } },
  };
  return { runtime, fireConnect: (p) => listener?.(p) };
}

function makeFakePort(name: string): {
  port: ChromeRuntimePort;
  posted: unknown[];
  onMessageListeners: Array<(msg: unknown, port: ChromeRuntimePort) => void>;
  onDisconnectListeners: Array<(port: ChromeRuntimePort) => void>;
} {
  const onMessageListeners: Array<(msg: unknown, port: ChromeRuntimePort) => void> = [];
  const onDisconnectListeners: Array<(port: ChromeRuntimePort) => void> = [];
  const posted: unknown[] = [];
  const port: ChromeRuntimePort = {
    name,
    postMessage: (m) => { posted.push(m); },
    onMessage: { addListener: (fn) => { onMessageListeners.push(fn); } },
    onDisconnect: { addListener: (fn) => { onDisconnectListeners.push(fn); } },
  };
  return { port, posted, onMessageListeners, onDisconnectListeners };
}

// ── spy orchestrator ───────────────────────────────────────────────────────

function makeSpyOrchestrator(activeTabs = new Set<number>()): {
  orchestrator: Orchestrator;
  translateBatchCalls: { items: unknown[]; ctx: TranslateContext }[];
  cancelCalls: number[];
} {
  const translateBatchCalls: { items: unknown[]; ctx: TranslateContext }[] = [];
  const cancelCalls: number[] = [];
  const orchestrator: Orchestrator = {
    async translateBatch(items, ctx) {
      translateBatchCalls.push({ items, ctx });
    },
    cancel(tabId) {
      cancelCalls.push(tabId);
    },
    isActive: (tabId) => activeTabs.has(tabId),
  };
  return { orchestrator, translateBatchCalls, cancelCalls };
}

const dummyEngine: Engine = { id: 'eng-1', provider: 'openai', async translate() { return { content: '' }; } };

function makeCtx(tabId: number): TranslateContext {
  return {
    tabId,
    engine: dummyEngine,
    engineId: dummyEngine.id,
    targetLang: 'zh',
    sourceLang: 'auto',
    mode: 'basic',
    scheduling: { maxConcurrent: 3, rps: 2, tpmLimit: 0, maxRetries: 5, itemsPerBatch: 20, batchTokenBudgetRatio: 0.7 },
    budget: { inputMax: 4000 },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ═══════════════════════════════════════════════════════════════════════════

describe('port-server', () => {
  it('TRANSLATE_BATCH：解析 tabId → buildContext → 交给 orchestrator.translateBatch', async () => {
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, translateBatchCalls } = makeSpyOrchestrator();
    const buildContext = vi.fn(async (tabId: number) => makeCtx(tabId));
    initPortServer({ orchestrator, buildContext }, runtime);

    const fp = makeFakePort('translate:42');
    fireConnect(fp.port);
    expect(buildContext).not.toHaveBeenCalled();

    const items = [{ id: '1', text: 'hi' }, { id: '2', text: 'world' }];
    fp.onMessageListeners[0]?.({ type: 'TRANSLATE_BATCH', items }, fp.port);
    await flush();

    expect(buildContext).toHaveBeenCalledWith(42);
    expect(translateBatchCalls).toHaveLength(1);
    expect(translateBatchCalls[0]?.ctx.tabId).toBe(42);
    expect(translateBatchCalls[0]?.items).toEqual(items);
  });

  it('CANCEL：调用 orchestrator.cancel(tabId)', async () => {
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, cancelCalls } = makeSpyOrchestrator();
    initPortServer({ orchestrator, buildContext: async () => makeCtx(7) }, runtime);

    const fp = makeFakePort('translate:7');
    fireConnect(fp.port);
    fp.onMessageListeners[0]?.({ type: 'CANCEL' }, fp.port);

    expect(cancelCalls).toContain(7);
  });

  it('onDisconnect：中止该 tab 在途翻译', async () => {
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, cancelCalls } = makeSpyOrchestrator();
    initPortServer({ orchestrator, buildContext: async () => makeCtx(9) }, runtime);

    const fp = makeFakePort('translate:9');
    fireConnect(fp.port);
    fp.onDisconnectListeners[0]?.(fp.port);

    expect(cancelCalls).toContain(9);
  });

  it('非翻译 Port（名字不匹配）：被忽略，不挂监听', async () => {
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, translateBatchCalls } = makeSpyOrchestrator();
    initPortServer({ orchestrator, buildContext: async () => makeCtx(1) }, runtime);

    const fp = makeFakePort('popup:whatever');
    fireConnect(fp.port);
    // port-server 提前 return，未挂 onMessage/onDisconnect
    expect(fp.onMessageListeners).toHaveLength(0);
    expect(fp.onDisconnectListeners).toHaveLength(0);

    // 即便误投消息，也不会触发翻译
    fp.onMessageListeners[0]?.({ type: 'TRANSLATE_BATCH', items: [] }, fp.port);
    await flush();
    expect(translateBatchCalls).toHaveLength(0);
  });

  it('重连同 tab 且上一轮仍在途：先 cancel 上一轮避免双发', async () => {
    const activeTabs = new Set<number>([5]); // tab 5 标记为在途
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, cancelCalls } = makeSpyOrchestrator(activeTabs);
    initPortServer({ orchestrator, buildContext: async () => makeCtx(5) }, runtime);

    fireConnect(makeFakePort('translate:5').port);
    // onConnect 检测到 isActive(5)=true → 先 cancel(5)
    expect(cancelCalls).toContain(5);
  });

  it('buildContext 失败：整批 ERROR 回传，不让 SW 崩', async () => {
    const { runtime, fireConnect } = makeFakeRuntime();
    const { orchestrator, translateBatchCalls } = makeSpyOrchestrator();
    initPortServer(
      { orchestrator, buildContext: async () => { throw new Error('no active engine'); } },
      runtime,
    );

    const fp = makeFakePort('translate:3');
    fireConnect(fp.port);
    fp.onMessageListeners[0]?.({ type: 'TRANSLATE_BATCH', items: [{ id: '1', text: 'x' }] }, fp.port);
    await flush();

    expect(translateBatchCalls).toHaveLength(0);
    expect(fp.posted).toEqual([
      expect.objectContaining({ type: 'ERROR', reason: 'no active engine' }),
    ]);
  });
});
