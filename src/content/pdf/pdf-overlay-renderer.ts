/**
 * PDF 译文叠加渲染 —— src/content/pdf/pdf-overlay-renderer.ts（P2-1 / TRA-24）。
 *
 * 见 docs/ARCHITECTURE.md 第 8 节 / 第 9 节「排版破坏」对策。与 HTML 双语渲染器
 * (bilingual-renderer.ts) 并列的 PDF 专用渲染层：
 *
 *   - 译文 wrapper 用**绝对定位**贴在 pdf.js 文本层对应段落的几何位置上（pdf.js 文本层
 *     本身就是绝对定位 span 堆叠，译文叠在其上，不破坏原排版 / 分页）。
 *   - 严格 `bt-` 前缀 CSS 隔离，绝不改动 pdf.js 产出的任何节点属性 / 类 / style。
 *   - 复用 P0-9 bilingual-renderer 的句柄语义（setText / appendChunk / markError /
 *     setDisplayMode / remove），使 PDF 与 HTML 两条渲染路径对上层控制器同形。
 *   - layout-guard 适配 pdf.js 重排：pdf.js 在缩放 / 滚动 / 跳页时**销毁并重建**文本层
 *     span，译文 wrapper 会被一并清掉。`PdfTextLayerWatch` 监听 `.textLayer` 子树变更，
 *     检测到重建即触发 `onReflow` 回调，由 pdf-controller 重新提取并重定位译文。
 *
 * 纯函数 `computeOverlayStyle(rect)` 单独导出，便于 jsdom 单测覆盖定位几何。
 */
import type { DisplayMode } from '../../shared/types';
import type { PdfParagraph, PdfRect } from './text-layer-extractor';

/** wrapper 基础类（bt- 前缀隔离，与 HTML 渲染器同名以复用样式语义，但独立样式表）。 */
const BASE_CLASS = 'bt-pdf-translation';
const TEXT_CLASS = `${BASE_CLASS}__text`;
const HIDDEN_CLASS = `${BASE_CLASS}--hidden`;
const ERROR_CLASS = `${BASE_CLASS}--error`;
/** 运行时样式表 id（整页唯一，与 HTML 渲染器分离避免重复注入冲突）。 */
const STYLE_ID = 'bt-pdf-runtime-styles';

/** 运行时样式 —— 作用域隔离，全部 bt-pdf- 前缀。绝对定位贴在文本层上，不参与文档流。 */
const CSS = `
.${BASE_CLASS} {
  position: absolute;
  pointer-events: auto;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  margin: 0;
  padding: 1px 2px;
  border-radius: 2px;
  font-size: inherit;
  line-height: 1.35;
  /* 半透明高亮底，让译文在 pdf.js 渲染层上可读，不完全遮盖原文。 */
  background: rgba(255, 243, 160, 0.18);
  z-index: 1;
}
.${HIDDEN_CLASS} { display: none !important; }
.${ERROR_CLASS} .${TEXT_CLASS} { color: #b00020; font-style: italic; }
.${ERROR_CLASS} .${TEXT_CLASS}::before { content: "\\26a0  "; }
`;

/** 计算译文 wrapper 的绝对定位样式（纯函数，px）。 */
export function computeOverlayStyle(rect: PdfRect): {
  left: string;
  top: string;
  width: string;
} {
  const width = Math.max(rect.right - rect.left, 0);
  return {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${width}px`,
  };
}

/** 确保运行时样式表只注入一次（幂等）。 */
export function ensurePdfStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export interface PdfOverlayOptions {
  displayMode?: DisplayMode;
  /** 文本填充钩子（与 HTML 渲染器同形）；默认纯文本。 */
  fillText?: (container: HTMLElement, text: string) => void;
}

/** 译文 overlay 句柄（与 bilingual-renderer.RenderHandle 同形子集）。 */
export interface PdfOverlayHandle {
  readonly id: string;
  readonly wrapper: HTMLElement;
  setText(text: string): void;
  appendChunk(chunk: string): void;
  markError(reason: string): void;
  clearError(): void;
  setDisplayMode(mode: DisplayMode): void;
  remove(): void;
}

function defaultFill(container: HTMLElement, text: string): void {
  container.replaceChildren(document.createTextNode(text));
}

/**
 * 渲染一段译文 overlay：在 pdf.js 文本层容器内创建绝对定位 wrapper，贴在 paragraph.rect。
 *
 * 容器需为定位上下文（pdf.js `.textLayer` 本身 position:absolute/relative）。本函数绝不
 * 改动容器内 pdf.js 产出的任何节点。
 */
export function renderPdfOverlay(
  paragraph: PdfParagraph,
  translated: string,
  container: HTMLElement,
  options: PdfOverlayOptions = {},
): PdfOverlayHandle {
  ensurePdfStyles();
  const fill = options.fillText ?? defaultFill;
  const displayMode = options.displayMode ?? 'bilingual';

  const wrapper = document.createElement('div');
  wrapper.className = BASE_CLASS;
  wrapper.dataset.btId = paragraph.id;
  wrapper.setAttribute('data-bt-pdf-translation', '');
  const style = computeOverlayStyle(paragraph.rect);
  wrapper.style.left = style.left;
  wrapper.style.top = style.top;
  wrapper.style.width = style.width;

  const textContainer = document.createElement('span');
  textContainer.className = TEXT_CLASS;
  fill(textContainer, translated);
  wrapper.appendChild(textContainer);

  if (displayMode === 'original') wrapper.classList.add(HIDDEN_CLASS);

  container.appendChild(wrapper);

  let buffer = translated;
  let errored = false;

  return {
    id: paragraph.id,
    wrapper,
    setText(next) {
      buffer = next;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      fill(textContainer, next);
    },
    appendChunk(chunk) {
      buffer += chunk;
      if (!errored) fill(textContainer, buffer);
    },
    markError(reason) {
      errored = true;
      wrapper.classList.add(ERROR_CLASS);
      textContainer.replaceChildren(document.createTextNode(`翻译失败：${reason}`));
    },
    clearError() {
      if (!errored) return;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      fill(textContainer, buffer);
    },
    setDisplayMode(mode) {
      wrapper.classList.toggle(HIDDEN_CLASS, mode === 'original');
    },
    remove() {
      wrapper.remove();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// pdf.js 重排守护：监听 `.textLayer` 子树重建，触发 onReflow
// ─────────────────────────────────────────────────────────────────────────

/**
 * pdf.js 重排检测器。pdf.js 在缩放 / 滚动 / 跳页时销毁并重建 `.textLayer` 的 span 子树，
 * 译文 wrapper 会被一并清掉。本守护监听子树 childList 变更，在「span 数量显著变化」或
 * 「wrapper 被移除」时触发 `onReflow`，由 pdf-controller 重新提取段落并重定位译文。
 *
 * 与 HTML LayoutGuard 的区别：HTML 是「wrapper 被移走 → 重插同一 wrapper」；PDF 是
 * 「文本层整体重建 → 旧 wrapper 失效，需按新几何重新渲染」，故走 reflow 回调而非重插。
 */
export class PdfTextLayerWatch {
  private observer: MutationObserver | null = null;
  private lastSpanCount = 0;
  private armed = false;

  /**
   * @param container `.textLayer` 容器
   * @param onReflow 检测到重排时的回调（节流：同 tick 多次变更只触发一次）
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly onReflow: () => void,
  ) {}

  /** 开始监听。 */
  start(): void {
    if (this.armed) return;
    this.armed = true;
    this.lastSpanCount = this.countSpans();
    if (typeof MutationObserver === 'undefined') return; // jsdom 降级
    this.observer = new MutationObserver(() => this.check());
    this.observer.observe(this.container, { childList: true, subtree: true });
  }

  /** 是否仍挂载监听。 */
  get active(): boolean {
    return this.armed;
  }

  /** 主动校验一次（外部触发时用）。 */
  check(): void {
    if (!this.armed) return;
    const cur = this.countSpans();
    // span 数量变化 > 2 视为重建（容忍 pdf.js 局部增量渲染的少量抖动）。
    if (Math.abs(cur - this.lastSpanCount) > 2) {
      this.lastSpanCount = cur;
      this.onReflow();
    }
  }

  /** 停止监听。 */
  stop(): void {
    this.armed = false;
    this.observer?.disconnect();
    this.observer = null;
  }

  private countSpans(): number {
    return this.container.querySelectorAll('span').length;
  }
}
