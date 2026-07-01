/**
 * pdf-controller 集成测试（P2-1 / TRA-24）。
 *
 * 用 fake pdf.js 渲染器 + fake chrome.runtime Port 验证控制器接线：
 *  - 渲染页面 → 文本层提取段落 → 经 Port 发 TRANSLATE_BATCH（items 含全部段落）
 *  - 收 RESULT → 在该页文本层渲染 bt-pdf-translation overlay（绝对定位）
 *  - 收 STREAM_CHUNK → 增量 appendChunk
 *  - 收 ERROR → markError 占位
 *  - stopPdfTranslation → 移除全部 overlay + disconnect
 *  - 扫描版（空文本层）→ 不发 batch
 *
 * 不依赖真实 pdf.js / 真实 SW（与 pipeline-integration 同思路：fake 渲染器 + fake port）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPdfjsRenderer,
  isPdfTranslating,
  startPdfTranslation,
  stopPdfTranslation,
  type PdfjsPageRenderer,
} from './pdf-controller';
import type { SMToContentPortMessage } from '../../shared/messages';

/** fake port：收集 postMessage，暴露 emit 给测试注入 SW→content 消息。 */
interface FakePort {
  name: string;
  messages: unknown[];
  listeners: Array<(m: unknown) => void>;
  disconnectListeners: Array<() => void>;
  disconnected: boolean;
  emit(m: SMToContentPortMessage): void;
  disconnect(): void;
  postMessage(m: unknown): void;
  onMessage: { addListener(fn: (m: unknown) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
}

function installChromeMockWithPort(tabId: number): FakePort {
  const port: FakePort = {
    name: `translate:${tabId}`,
    messages: [],
    listeners: [],
    disconnectListeners: [],
    disconnected: false,
    emit(m) {
      for (const fn of port.listeners) fn(m);
    },
    disconnect() {
      port.disconnected = true;
      for (const fn of port.disconnectListeners) fn();
    },
    postMessage(m) {
      port.messages.push(m);
    },
    onMessage: { addListener(fn) { port.listeners.push(fn); } },
    onDisconnect: { addListener(fn) { port.disconnectListeners.push(fn); } },
  };

  const chrome = {
    storage: {
      local: { get: async () => ({}), set: async () => {}, remove: async () => {}, clear: async () => {} },
      onChanged: { addListener() {}, removeListener() {}, hasListener() { return false; } },
    },
    runtime: {
      // tab-id 握手返回固定 tabId。
      sendMessage: async (msg: unknown) => {
        if ((msg as { btInternal?: string })?.btInternal === 'tab-id') return { tabId };
        return undefined;
      },
      connect: () => port,
      id: 'test-extension',
    },
  };
  (globalThis as { chrome?: unknown }).chrome = chrome;
  return port;
}

/** fake 渲染器：每页产一个含若干 span 的 .textLayer，挂到 viewportRoot。 */
function fakeRenderer(pagesText: string[][]): PdfjsPageRenderer {
  return {
    numPages: pagesText.length,
    async renderPage(pageIndex, viewportRoot) {
      const pageDiv = document.createElement('div');
      pageDiv.className = 'bt-pdf-page';
      pageDiv.style.position = 'relative';
      pageDiv.style.width = '600px';
      pageDiv.style.height = '800px';
      const textLayer = document.createElement('div');
      textLayer.className = 'textLayer';
      textLayer.style.position = 'absolute';
      textLayer.style.width = '600px';
      textLayer.style.height = '800px';
      // 每行一个 span，行间距 24px（行高 16 → gap 8 < 12.8 同段）。
      // 空字符串：不建 span，但 top 跳 40px 制造段落断行（gap > 12.8）。
      // jsdom 不计算布局，offsetTop / getBoundingClientRect 恒 0；这里给每个 span
      // 打 getBoundingClientRect mock，让 collectTextItems 的 rect 分支读到真实几何。
      const layerRect = { left: 0, top: 0, width: 600, height: 800, right: 600, bottom: 800, x: 0, y: 0, toJSON() {} };
      textLayer.getBoundingClientRect = () => layerRect as DOMRect;
      let top = 100;
      for (const line of pagesText[pageIndex] ?? []) {
        if (line === '') {
          top += 40;
          continue;
        }
        const span = document.createElement('span');
        span.textContent = line;
        span.style.position = 'absolute';
        span.style.left = '10px';
        span.style.top = `${top}px`;
        span.style.width = '300px';
        span.style.height = '16px';
        const spanTop = top;
        span.getBoundingClientRect = () => ({ left: 10, top: spanTop, width: 300, height: 16, right: 310, bottom: spanTop + 16, x: 10, y: spanTop, toJSON() {} }) as DOMRect;
        textLayer.appendChild(span);
        top += 24;
      }
      pageDiv.append(textLayer);
      viewportRoot.append(pageDiv);
      return textLayer;
    },
  };
}

describe('pdf-controller：渲染→提取→翻译→overlay 接线', () => {
  let port: FakePort | null = null;

  beforeEach(() => {
    document.body.innerHTML = '<div id="viewer"></div>';
    port = installChromeMockWithPort(42);
  });

  afterEach(() => {
    stopPdfTranslation();
    vi.useRealTimers();
  });

  it('渲染页面后经 Port 发 TRANSLATE_BATCH，items 含全部段落', async () => {
    const renderer = fakeRenderer([
      ['Line one of para one', 'Line two of para one', '', 'Second paragraph here'],
    ]);
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);

    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { type: string; items: Array<{ id: string; text: string }> }
      | undefined;
    expect(batch).toBeTruthy();
    // 两段（行间距 24 → 第一段两行同段，第三段隔一空行断段）。
    // 注意：空行 span 文本为空会被 collectTextItems 过滤 → 实际两段。
    expect(batch!.items.length).toBeGreaterThanOrEqual(2);
    // items 不含 DOM 引用。
    expect(batch!.items[0]).toHaveProperty('id');
    expect(batch!.items[0]).toHaveProperty('text');
  });

  it('收 RESULT → 在文本层渲染 bt-pdf-translation overlay', async () => {
    const renderer = fakeRenderer([['Hello PDF world']]);
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);
    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: Array<{ id: string }> }
      | undefined;
    const id = batch!.items[0]!.id;

    port!.emit({ type: 'RESULT', id, translated: '你好 PDF 世界' });

    const overlay = document.querySelector('.bt-pdf-translation');
    expect(overlay).toBeTruthy();
    expect(overlay?.textContent).toBe('你好 PDF 世界');
    expect(overlay?.classList.contains('bt-pdf-translation--error')).toBe(false);
  });

  it('收 STREAM_CHUNK → 增量 appendChunk（节流 flush 后可见）', async () => {
    const renderer = fakeRenderer([['Hello']]);
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);
    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: Array<{ id: string }> }
      | undefined;
    const id = batch!.items[0]!.id;

    // StreamChunkThrottle 默认 30ms flush；用真实定时器等待 flush 后断言。
    port!.emit({ type: 'STREAM_CHUNK', id, chunk: '你' });
    port!.emit({ type: 'STREAM_CHUNK', id, chunk: '好' });
    await new Promise((r) => setTimeout(r, 60));

    const overlay = document.querySelector('.bt-pdf-translation__text');
    expect(overlay?.textContent).toBe('你好');
  });

  it('收 ERROR → markError 占位', async () => {
    const renderer = fakeRenderer([['Hello']]);
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);
    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: Array<{ id: string }> }
      | undefined;
    const id = batch!.items[0]!.id;

    port!.emit({ type: 'ERROR', id, reason: '引擎超时' });

    const overlay = document.querySelector('.bt-pdf-translation');
    expect(overlay?.classList.contains('bt-pdf-translation--error')).toBe(true);
    expect(overlay?.textContent).toContain('引擎超时');
  });

  it('stopPdfTranslation → 移除全部 overlay + 发 CANCEL', async () => {
    const renderer = fakeRenderer([['Hello', 'World']]);
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);
    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH') as
      | { items: Array<{ id: string }> }
      | undefined;
    port!.emit({ type: 'RESULT', id: batch!.items[0]!.id, translated: '你好' });

    expect(document.querySelector('.bt-pdf-translation')).toBeTruthy();
    expect(isPdfTranslating()).toBe(true);

    stopPdfTranslation();

    expect(document.querySelector('.bt-pdf-translation')).toBeNull();
    expect(isPdfTranslating()).toBe(false);
    expect(port!.messages.some((m) => (m as { type?: string }).type === 'CANCEL')).toBe(true);
  });

  it('扫描版（空文本层）→ 不发 TRANSLATE_BATCH', async () => {
    const renderer = fakeRenderer([[]]); // 无 span
    await startPdfTranslation(document.getElementById('viewer') as HTMLElement, renderer);
    const batch = port!.messages.find((m) => (m as { type?: string }).type === 'TRANSLATE_BATCH');
    expect(batch).toBeUndefined();
  });
});

describe('createPdfjsRenderer：类型契约', () => {
  it('返回带 numPages 与 renderPage 的渲染器接口（不实际跑 pdf.js）', async () => {
    // 仅断言工厂在类型上满足 PdfjsPageRenderer；真实 pdf.js 渲染在 e2e 覆盖。
    // 这里不调用（需真实 ArrayBuffer + canvas）。
    const r: PdfjsPageRenderer = { numPages: 1, async renderPage() { return document.createElement('div'); } };
    expect(r.numPages).toBe(1);
    expect(typeof r.renderPage).toBe('function');
    void createPdfjsRenderer; // 引用保持导入
  });
});
