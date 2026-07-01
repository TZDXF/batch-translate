/**
 * PDF 翻译编排 —— src/content/pdf/pdf-controller.ts（P2-1 / TRA-24）。
 *
 * 与 HTML content/controller.ts 并列的 PDF 专用控制器，复用同一条翻译主通道：
 *
 *   pdf.js 渲染页面 → 每页文本层提取段落（text-layer-extractor）
 *   → 连接 `translate:<tabId>` Port（与 HTML 同通道，复用 orchestrator + P1 流式 + 上下文）
 *   → TRANSLATE_BATCH 下发 items → 收 RESULT/STREAM_CHUNK/ERROR
 *   → pdf-overlay-renderer 在该页文本层绝对定位译文 wrapper（bt- 隔离，不破坏排版/分页）
 *   → PdfTextLayerWatch 监听 pdf.js 重排 → 重新提取该页段落并重定位译文
 *
 * 关键复用（零 SW 改动）：
 *  - 翻译编排器 / 缓存 / 并发 / 流式 / 上下文注入：全部走既有 Port 协议，SW 侧无感知 PDF。
 *  - 段落 id：复用 P0 dom-walker 的 hashId（经 text-layer-extractor）。
 *  - 流式节流：复用 StreamChunkThrottle。
 *
 * 与 HTML 控制器的差异：
 *  - 段落来源：pdf.js 文本层（几何聚合）而非 dom-walker。
 *  - 渲染：绝对定位 overlay（pdf-overlay-renderer）而非「原段落后插兄弟」。
 *  - 段落映射：id → {paragraph, pageContainer, handle}，按页组织。
 */
import { translatePortName } from '../../shared/constants';
import {
  isBatchDone,
  isError,
  isPortMessage,
  isProgress,
  isResult,
  isStreamChunk,
} from '../../shared/messages';
import type { DisplayMode, Item } from '../../shared/types';
import { loadConfig } from '../../background/config/config-store';
import { StreamChunkThrottle } from '../stream-chunk-buffer';
import {
  collectTextItems,
  extractPdfParagraphs,
  type PdfParagraph,
} from './text-layer-extractor';
import {
  PdfTextLayerWatch,
  renderPdfOverlay,
  type PdfOverlayHandle,
} from './pdf-overlay-renderer';
import { loadPdfjs } from './pdfjs-loader';

/** 单页渲染产物：页容器 + 文本层容器 + 该页段落。 */
interface PdfPage {
  pageIndex: number;
  /** 该页 `.textLayer` 容器（译文 overlay 挂在这里）。 */
  textLayer: HTMLElement;
  /** 该页段落（按出现顺序）。 */
  paragraphs: PdfParagraph[];
  /** 重排守护。 */
  watch: PdfTextLayerWatch;
}

interface ParagraphEntry {
  paragraph: PdfParagraph;
  page: PdfPage;
  handle: PdfOverlayHandle | undefined;
}

/** 渲染一页 PDF 的可注入依赖（便于测试 / 替换 pdf.js）。 */
export interface PdfjsPageRenderer {
  /** 渲染第 pageIndex 页，返回该页的 `.textLayer` 容器（已挂载到 DOM）。 */
  renderPage(pageIndex: number, viewportRoot: HTMLElement): Promise<HTMLElement>;
  /** PDF 总页数。 */
  numPages: number;
}

/** 控制器配置。 */
export interface PdfControllerConfig {
  displayMode?: DisplayMode;
}

/** 内部状态。 */
interface PdfState {
  pages: PdfPage[];
  registry: Map<string, ParagraphEntry>;
  port: chrome.runtime.Port | null;
  on: boolean;
  tabId: number | null;
  displayMode: DisplayMode;
  doneCount: number;
  total: number;
}

let state: PdfState | null = null;
const streamThrottle = new StreamChunkThrottle({
  onFlush(id, delta) {
    const entry = state?.registry.get(id);
    if (entry?.handle) entry.handle.appendChunk(delta);
  },
});

/** content 无法直接读自身 tabId；通过内部握手向 SW 取（sender.tab.id）。 */
async function getMyTabId(): Promise<number | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({ btInternal: 'tab-id' })) as { tabId?: number } | undefined;
    return typeof resp?.tabId === 'number' ? resp.tabId : null;
  } catch {
    return null;
  }
}

/**
 * 启动 PDF 翻译：用给定渲染器逐页渲染 → 提取段落 → 下发翻译 → 渲染 overlay。
 *
 * @param viewportRoot PDF 渲染根容器（pdf.js 的 `.pdfViewer` / 自建容器）
 * @param renderer pdf.js 页面渲染器（生产由 loadPdfjs 装配，测试可注入 fake）
 * @param cfg 显示模式等
 */
export async function startPdfTranslation(
  viewportRoot: HTMLElement,
  renderer: PdfjsPageRenderer,
  cfg: PdfControllerConfig = {},
): Promise<void> {
  if (state?.on) return;
  const tabId = await getMyTabId();
  if (tabId == null) throw new Error('PDF 翻译：无法识别当前标签页');

  let displayMode: DisplayMode = 'bilingual';
  try {
    const c = await loadConfig();
    displayMode = cfg.displayMode ?? c.ui.displayMode;
  } catch {
    /* 配置读取失败走默认 */
  }

  state = {
    pages: [],
    registry: new Map(),
    port: null,
    on: true,
    tabId,
    displayMode,
    doneCount: 0,
    total: 0,
  };

  // 连接翻译 Port（与 HTML 同通道，SW 侧 orchestrator 无感知差异）。
  const port = chrome.runtime.connect({ name: translatePortName(tabId) });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    if (!state) return;
    state.on = false;
    state.port = null;
  });
  state.port = port;

  // 逐页渲染 + 提取段落。
  const allItems: Item[] = [];
  for (let i = 0; i < renderer.numPages; i++) {
    if (!state.on) return; // 中途取消
    const textLayer = await renderer.renderPage(i, viewportRoot);
    const pageHeight = textLayer.offsetHeight || textLayer.getBoundingClientRect().height || 0;
    const items = collectTextItems(textLayer);
    const paragraphs = extractPdfParagraphs(items, pageHeight, i);
    const watch = new PdfTextLayerWatch(textLayer, () => {
      void onReflow(i, textLayer);
    });
    watch.start();
    const page: PdfPage = { pageIndex: i, textLayer, paragraphs, watch };
    state.pages.push(page);
    for (const p of paragraphs) {
      state.registry.set(p.id, { paragraph: p, page, handle: undefined });
      allItems.push({ id: p.id, text: p.text });
    }
  }

  state.total = allItems.length;
  if (allItems.length === 0) {
    // 无文本层（扫描版 PDF）→ 走 P2-3 OCR 兜底，本 issue 不实现。
    port.disconnect();
    state.on = false;
    return;
  }
  port.postMessage({ type: 'TRANSLATE_BATCH', items: allItems });
}

/** 停止 PDF 翻译：取消在途、移除全部 overlay、停重排守护。 */
export function stopPdfTranslation(): void {
  if (!state) return;
  state.on = false;
  try {
    state.port?.postMessage({ type: 'CANCEL' });
  } catch {
    /* port 已断 */
  }
  try {
    state.port?.disconnect();
  } catch {
    /* noop */
  }
  streamThrottle.clear();
  for (const page of state.pages) page.watch.stop();
  for (const entry of state.registry.values()) entry.handle?.remove();
  state = null;
}

/** 当前是否翻译中。 */
export function isPdfTranslating(): boolean {
  return state?.on ?? false;
}

/** pdf.js 重排：重新提取该页段落，重定位已有译文 overlay（按 id 复用译文文本）。 */
async function onReflow(
  pageIndex: number,
  textLayer: HTMLElement,
): Promise<void> {
  if (!state || !state.on) return;
  const page = state.pages.find((p) => p.pageIndex === pageIndex);
  if (!page) return;
  // 保留旧段落的译文文本（按 id），用于重排后立即回填（不重发请求）。
  const prevTranslated = new Map<string, string>();
  for (const p of page.paragraphs) {
    const entry = state.registry.get(p.id);
    if (entry?.handle) {
      // handle.wrapper 在重排中被 pdf.js 清掉 → 用其缓存的 buffer 重建。
      // PdfOverlayHandle 未暴露 getText，这里通过 wrapper 文本取回。
      const text = entry.handle.wrapper.querySelector('.bt-pdf-translation__text')?.textContent ?? '';
      if (text) prevTranslated.set(p.id, text);
      entry.handle = undefined;
    }
  }
  // 重新提取。
  const items = collectTextItems(textLayer);
  const pageHeight = textLayer.offsetHeight || textLayer.getBoundingClientRect().height || 0;
  const newParagraphs = extractPdfParagraphs(items, pageHeight, pageIndex);
  page.paragraphs = newParagraphs;
  // 重排后 id 可能变化（几何变了 → 文本聚合可能不同），按 id 匹配回填已有译文；
  // 未命中的新段落不重发（避免重排风暴触发请求），等下次主动翻译。
  for (const p of newParagraphs) {
    const entry = state.registry.get(p.id);
    if (entry) {
      entry.paragraph = p;
      const prev = prevTranslated.get(p.id);
      if (prev !== undefined) {
        entry.handle = renderPdfOverlay(p, prev, textLayer, { displayMode: state.displayMode });
      }
    }
  }
}

function ensureHandle(id: string): ParagraphEntry | undefined {
  if (!state) return undefined;
  const entry = state.registry.get(id);
  if (!entry) return undefined;
  if (!entry.handle) {
    entry.handle = renderPdfOverlay(entry.paragraph, '', entry.page.textLayer, {
      displayMode: state.displayMode,
    });
  }
  return entry;
}

function applyResult(id: string, translated: string): void {
  const entry = ensureHandle(id);
  if (!entry) return;
  entry.handle?.setText(translated);
  if (state) state.doneCount += 1;
}

function applyStreamChunk(id: string, chunk: string): void {
  if (!state) return;
  ensureHandle(id);
  streamThrottle.push(id, chunk);
}

function applyError(id: string, reason: string): void {
  const entry = ensureHandle(id);
  if (!entry) return;
  entry.handle?.markError(reason);
}

function onPortMessage(m: unknown): void {
  if (!isPortMessage(m)) return;
  if (isResult(m)) {
    streamThrottle.discard(m.id);
    applyResult(m.id, m.translated);
  } else if (isStreamChunk(m)) {
    applyStreamChunk(m.id, m.chunk);
  } else if (isError(m)) {
    streamThrottle.discard(m.id);
    applyError(m.id, m.reason);
  } else if (isProgress(m)) {
    /* PDF 暂不细分进度展示 */
  } else if (isBatchDone(m)) {
    /* 批次完成：进度已随 RESULT 累加 */
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 生产用 pdf.js 页面渲染器（基于 loadPdfjs）
// ─────────────────────────────────────────────────────────────────────────

/**
 * 用真实 pdf.js 渲染 PDF。每页：getViewport → 渲染 canvas + 文本层到 viewportRoot。
 * 返回该页 `.textLayer` 容器供 overlay 挂载。
 *
 * @param data PDF 二进制（ArrayBuffer）
 */
export async function createPdfjsRenderer(data: ArrayBuffer): Promise<PdfjsPageRenderer> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data }).promise;
  const numPages = doc.numPages;

  const renderPage = async (pageIndex: number, viewportRoot: HTMLElement): Promise<HTMLElement> => {
    const page = await doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: 1.5 });

    // canvas 渲染层。
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.className = 'bt-pdf-canvas';
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('PDF 渲染：无法获取 2d context');
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;

    // 文本层。pdf.js v4+ 提供 `pdfjs.renderTextLayer({ textContentSource, container, viewport })`。
    // 这里手动构建：取 textContent → 用 pdfjs TextItem 几何放入绝对定位 span。
    // 为兼容多版本，直接用 pdfjs 暴露的 renderTextLayer（若存在）。
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.position = 'absolute';
    textLayer.style.left = '0';
    textLayer.style.top = '0';
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;

    const pageDiv = document.createElement('div');
    pageDiv.className = 'bt-pdf-page';
    pageDiv.style.position = 'relative';
    pageDiv.style.width = `${viewport.width}px`;
    pageDiv.style.height = `${viewport.height}px`;
    pageDiv.append(canvas, textLayer);
    viewportRoot.append(pageDiv);

    // 优先用 pdfjs 官方 renderTextLayer（v4+ API）。
    const textContent = await page.getTextContent();
    const anyPdfjs = pdfjs as unknown as {
      renderTextLayer?: (opts: {
        textContentSource: typeof textContent;
        container: HTMLElement;
        viewport: typeof viewport;
      }) => Promise<{ promise?: Promise<void> } | void>;
    };
    if (typeof anyPdfjs.renderTextLayer === 'function') {
      const task = await anyPdfjs.renderTextLayer({
        textContentSource: textContent,
        container: textLayer,
        viewport,
      });
      await (task?.promise ?? Promise.resolve());
    } else {
      // 兜底：手动按 textContent 几何生成 span（不依赖内部 API）。
      for (const item of textContent.items) {
        const ti = item as { str?: string; transform?: number[]; width?: number; height?: number };
        if (!ti.str || !ti.transform) continue;
        const tx = ti.transform;
        const span = document.createElement('span');
        span.textContent = ti.str;
        span.style.position = 'absolute';
        span.style.left = `${tx[4] ?? 0}px`;
        span.style.top = `${(tx[5] ?? 0) - (ti.height ?? 12)}px`;
        span.style.fontSize = `${ti.height ?? 12}px`;
        if (ti.width) span.style.width = `${ti.width}px`;
        textLayer.appendChild(span);
      }
    }

    return textLayer;
  };

  return { renderPage, numPages };
}
