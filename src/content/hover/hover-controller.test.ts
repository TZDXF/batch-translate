/**
 * hover-controller 测试（P2-4 / TRA-27）：hover 防抖、段落命中判定、缓存命中路径、
 * Port 单发路径、浮层生命周期（RESULT/STREAM_CHUNK/ERROR 回填）、离开销毁。
 *
 * 纯 jsdom + fake port + chrome mock（fake-indexeddb 提供 IDB，供 cache-access 读写）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installChromeMock, type ChromeMock } from '../../test/chrome-mock';
import {
  HoverController,
  findTranslatableBlock,
  hoverId,
  isOwnUI,
  DEFAULT_HOVER_DWELL_MS,
} from './hover-controller';
import type { AppConfig } from '../../shared/types';

// ── fake port：模拟 chrome.runtime.Port ─────────────────────────────────────
interface FakePort {
  name: string;
  posted: unknown[];
  onMessageListeners: Array<(m: unknown) => void>;
  onDisconnectListeners: Array<() => void>;
  postMessage(m: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: (m: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  /** 测试用：从 SW 侧推一条消息给 content。 */
  emit(m: unknown): void;
}

function makeFakePort(name: string): FakePort {
  const onMessageListeners: Array<(m: unknown) => void> = [];
  const onDisconnectListeners: Array<() => void> = [];
  const posted: unknown[] = [];
  return {
    name,
    posted,
    onMessageListeners,
    onDisconnectListeners,
    postMessage(m) { posted.push(m); },
    disconnect() { for (const fn of onDisconnectListeners) fn(); },
    onMessage: { addListener: (fn) => { onMessageListeners.push(fn); } },
    onDisconnect: { addListener: (fn) => { onDisconnectListeners.push(fn); } },
    emit(m) { for (const fn of onMessageListeners) fn(m); },
  };
}

/** 同步调度器（dwell 立即触发），便于断言。 */
function syncScheduler(): {
  sched: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
} {
  return {
    sched: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
  };
}

/** 刷新微任务 + IDB 事务（fake-indexeddb 经多次 microtask 才 settle）。 */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function fixtureDoc(): void {
  document.body.innerHTML = `
    <main>
      <article>
        <h1>Machine Translation</h1>
        <p id="p1">Machine translation translates text from one language to another.</p>
        <p id="p2">Early systems used rules and dictionaries.</p>
        <pre><code>const x = 42;</code></pre>
        <p id="p3">hi</p>
      </article>
    </main>
  `;
  // jsdom getBoundingClientRect 默认全 0；reposition 不会抛错。
}

function makeConfig(): AppConfig {
  return {
    version: 1,
    engines: { e1: { id: 'e1', label: 'E', provider: 'openai-compatible', baseUrl: '', model: 'm', enabled: true, apiKeyRef: 'r', contextWindow: 8000, maxOutput: 1000 } },
    activeEngineId: 'e1',
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'basic',
    agent: { systemPrompt: '', role: '', stylePreset: 'none', glossaryIds: [], pageContextEnabled: false },
    scheduling: { maxConcurrent: 3, rps: 2, tpmLimit: 0, maxRetries: 5, itemsPerBatch: 20, batchTokenBudgetRatio: 0.7 },
    cache: { enabled: true, maxSizeMB: 100, ttlDays: 0 },
    streaming: { enabled: false, engineUnsupportedFallback: true },
    ui: { showOriginal: true, translationStyle: 'normal', hoverOnly: true, displayMode: 'bilingual' },
    domain: { mode: 'blacklist', blacklist: [], whitelist: [] },
    shortcuts: { toggle: 'Alt+Shift+T', cycleDisplayMode: 'Alt+Shift+D', retranslate: 'Alt+Shift+R' },
  };
}

function fireMouseOver(el: Element): void {
  el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true }));
}
function fireMouseOut(el: Element, related: Element | null = null): void {
  el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, cancelable: true, relatedTarget: related }));
}

describe('findTranslatableBlock —— 段落命中判定', () => {
  beforeEach(() => {
    fixtureDoc();
  });

  it('命中 <p>：返回稳定 id + 占位符', () => {
    const p1 = document.getElementById('p1')!;
    const hit = findTranslatableBlock(p1, 2);
    expect(hit).not.toBeNull();
    expect(hit!.node).toBe(p1);
    expect(hit!.text).toContain('Machine translation');
    expect(hit!.id).toBe(hoverId(hit!.text));
  });

  it('从内联子元素上溯命中最近的块级段落', () => {
    document.body.innerHTML = `<main><p id="px">Hello <strong>world</strong>.</p></main>`;
    const strong = document.querySelector('strong')!;
    const hit = findTranslatableBlock(strong, 2);
    expect(hit).not.toBeNull();
    expect(hit!.node.id).toBe('px');
  });

  it('代码块不命中（code/pre 排除）', () => {
    const code = document.querySelector('code')!;
    expect(findTranslatableBlock(code, 2)).toBeNull();
  });

  it('过短段落不命中（< minChars）', () => {
    const p3 = document.getElementById('p3')!;
    // "hi" 长度 2，minChars=3 → 长度不足过滤。
    expect(findTranslatableBlock(p3, 3)).toBeNull();
  });

  it('扩展自身 UI 不命中', () => {
    const overlay = document.createElement('div');
    overlay.setAttribute('data-bt-hover', '');
    document.body.appendChild(overlay);
    expect(isOwnUI(overlay)).toBe(true);
    expect(findTranslatableBlock(overlay, 2)).toBeNull();
  });

  it('hoverId 稳定：相同文本同 id，不同文本不同 id', () => {
    expect(hoverId('hello world')).toBe(hoverId('hello world'));
    expect(hoverId('hello world')).not.toBe(hoverId('goodbye world'));
    // 空白归一化不影响 id
    expect(hoverId('hello   world')).toBe(hoverId('hello world'));
  });
});

describe('HoverController —— 防抖 + 浮层生命周期', () => {
  let mock: ChromeMock;
  beforeEach(async () => {
    fixtureDoc();
    mock = installChromeMock();
    // 写入默认配置到 storage（loadConfig 读取）。
    mock._store.set('config', makeConfig());
  });

  it('hover 命中段落：浮层挂载 + loading 态 + dwell 后触发翻译', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
      dwellMs: DEFAULT_HOVER_DWELL_MS,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);

    // 浮层已挂载 + loading 态。
    const overlay = document.querySelector('[data-bt-hover]') as HTMLDivElement | null;
    expect(overlay).not.toBeNull();
    expect(overlay!.textContent).toContain('翻译中');

    // dwell（同步）已触发 → 缓存 miss → Port 单发 TRANSLATE_BATCH（batch=1）。
    await vi.waitFor(() => {
      expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(true);
    });
    const batch = fakePort.posted.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { type: string; items: { id: string; text: string }[] } | undefined;
    expect(batch).toBeDefined();
    expect(batch!.items.length).toBe(1);
    expect(batch!.items[0]!.text).toContain('Machine translation');

    // RESULT 回填浮层。
    fakePort.emit({ type: 'RESULT', id: batch!.items[0]!.id, translated: '机器翻译。' });
    expect(overlay!.textContent).toContain('机器翻译。');

    ctrl.stop();
  });

  it('离开段落销毁浮层', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);
    expect(document.querySelector('[data-bt-hover]')).not.toBeNull();

    // 离开 p1（relatedTarget 不在 p1 内）→ 浮层销毁。
    fireMouseOut(p1, document.body);
    expect(document.querySelector('[data-bt-hover]')).toBeNull();

    ctrl.stop();
  });

  it('ERROR 回填：浮层显示错误占位', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);
    await vi.waitFor(() => {
      expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(true);
    });
    const batch = fakePort.posted.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: { id: string }[] } | undefined;
    expect(batch).toBeDefined();

    fakePort.emit({ type: 'ERROR', id: batch!.items[0]!.id, reason: 'engine down' });
    const overlay = document.querySelector('[data-bt-hover]') as HTMLDivElement;
    expect(overlay.textContent).toContain('翻译失败：engine down');
    expect(overlay.className).toContain('bt-hover__error');

    ctrl.stop();
  });

  it('STREAM_CHUNK 增量回填浮层', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);
    await vi.waitFor(() => {
      expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(true);
    });
    const batch = fakePort.posted.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: { id: string }[] } | undefined;

    fakePort.emit({ type: 'STREAM_CHUNK', id: batch!.items[0]!.id, chunk: '你' });
    fakePort.emit({ type: 'STREAM_CHUNK', id: batch!.items[0]!.id, chunk: '好' });
    const overlay = document.querySelector('[data-bt-hover]') as HTMLDivElement;
    expect(overlay.textContent).toContain('你好');

    ctrl.stop();
  });

  it('全页翻译进行中不触发 hover 翻译（避免双发）', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => true, // 全页进行中
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);
    await flush();
    await flush();
    // 浮层挂载但未发 TRANSLATE_BATCH（全页进行中跳过）。
    expect(document.querySelector('[data-bt-hover]')).not.toBeNull();
    expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(false);

    ctrl.stop();
  });
});

describe('HoverController —— 缓存命中近零延迟', () => {
  let mock: ChromeMock;
  beforeEach(async () => {
    fixtureDoc();
    mock = installChromeMock();
    mock._store.set('config', makeConfig());
  });

  it('缓存命中：直接填浮层，不发 TRANSLATE_BATCH', async () => {
    const fakePort = makeFakePort('translate:5');
    const { sched } = syncScheduler();

    // 预写缓存：用 cache-access.writebackCache 按 cache-key 写入。
    const { writebackCache, readCache } = await import('../cache-access');
    const cfg = makeConfig();
    const source = 'Machine translation translates text from one language to another.';
    await writebackCache(source, '机器翻译把文本从一种语言翻译成另一种。', cfg);
    expect((await readCache(source, cfg))?.translated).toContain('机器翻译');

    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();

    const p1 = document.getElementById('p1')!;
    fireMouseOver(p1);
    // 缓存命中 → 直接填浮层，不发 TRANSLATE_BATCH。
    await vi.waitFor(() => {
      const overlay = document.querySelector('[data-bt-hover]') as HTMLDivElement;
      expect(overlay.textContent).toContain('机器翻译把文本从一种语言');
    });
    const overlay = document.querySelector('[data-bt-hover]') as HTMLDivElement;
    expect(overlay.textContent).toContain('机器翻译把文本从一种语言');
    expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(false);

    ctrl.stop();
  });
});

describe('HoverController —— start/stop 幂等', () => {
  let mock: ChromeMock;
  beforeEach(async () => {
    fixtureDoc();
    mock = installChromeMock();
    mock._store.set('config', makeConfig());
  });

  it('stop 移除浮层 + 断开 Port', async () => {
    const fakePort = makeFakePort('translate:5');
    const disconnectSpy = vi.spyOn(fakePort, 'disconnect');
    const { sched } = syncScheduler();
    const ctrl = new HoverController({
      deps: {
        getTabId: async () => 5,
        isFullPageTranslating: () => false,
        connectPort: () => fakePort as unknown as chrome.runtime.Port,
      },
      scheduler: sched,
    });
    await ctrl.start();
    // 用 p2（未被其他测试缓存），确保走 Port 单发路径而非缓存命中。
    const p2 = document.getElementById('p2')!;
    fireMouseOver(p2);
    // 等 Port 连接 + TRANSLATE_BATCH 下发（确保 port 已建）。
    await vi.waitFor(() => {
      expect(fakePort.posted.some((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH')).toBe(true);
    });

    ctrl.stop();
    expect(document.querySelector('[data-bt-hover]')).toBeNull();
    expect(disconnectSpy).toHaveBeenCalled();
    // 再次 stop 幂等不抛错。
    expect(() => ctrl.stop()).not.toThrow();
  });
});
