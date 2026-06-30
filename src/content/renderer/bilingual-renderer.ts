/**
 * bilingual-renderer —— 双语对照渲染（架构第 2、3、9 节）。
 *
 * 核心契约：
 * - 在原段落节点「之后」插入译文 wrapper（`<div class="bt-translation">`），display:block 隔离。
 * - 绝不改动原节点的任何属性 / 类 / style（注入阶段零污染，保护页面样式与脚本选择器）。
 * - 容器感知：表格 / flex / grid 下插到不破结构的位置（委托 layout-guard 解析）。
 * - 支持 showOriginal 显示模式切换、译文样式预设、原位错误占位、流式追加（P1）。
 *
 * 作用域隔离：所有 CSS 用 `bt-` 前缀类 + 单一注入样式表，不污染页面。
 * 译文 DOM 还原（`[[n]]` 占位符）通过 restoreMarkup 钩子委托给 P0-8 inline-markup，
 * 未注入时降级为纯文本（占位符原样显示）。
 */
import type { DisplayMode, Paragraph, TranslationStyle } from '../../shared/types';
import {
  insertWrapper,
  resolveInsertionPoint,
  type InsertionTarget,
} from './layout-guard';

/** 运行时样式表 id（整页唯一）。 */
const STYLE_ID = 'bt-runtime-styles';
/** wrapper 基础类。 */
const BASE_CLASS = 'bt-translation';

/** 样式预设 → 修饰类。 */
const STYLE_CLASSES: Record<TranslationStyle, string> = {
  normal: '',
  blur: `${BASE_CLASS}--blur`,
  underline: `${BASE_CLASS}--underline`,
  highlight: `${BASE_CLASS}--highlight`,
};

/** 隐藏修饰类（displayMode === 'original' 时隐藏译文）。 */
const HIDDEN_CLASS = `${BASE_CLASS}--hidden`;
/** 错误修饰类。 */
const ERROR_CLASS = `${BASE_CLASS}--error`;
/** 仅译文模式下，隐藏原文用的可逆 data 属性（架构 ui.showOriginal 预期行为）。 */
const ORIGINAL_HIDDEN_ATTR = 'data-bt-original';

/** 运行时样式 —— 作用域隔离，全部 bt- 前缀，不触碰页面既有规则。 */
const CSS = `
.${BASE_CLASS} {
  display: block;
  max-width: 100%;
  box-sizing: border-box;
  overflow-wrap: anywhere;
  margin: 0.25em 0;
  font-size: inherit;
  line-height: inherit;
}
.${HIDDEN_CLASS} { display: none !important; }
.${BASE_CLASS}--blur { filter: blur(3px); transition: filter .2s ease; cursor: pointer; }
.${BASE_CLASS}--blur:hover { filter: none; }
.${BASE_CLASS}--underline { text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(0,0,0,.35); }
.${BASE_CLASS}--highlight { background: linear-gradient(transparent 55%, rgba(255,243,160,.85) 55%); }
.${ERROR_CLASS} { color: #b00020; font-style: italic; opacity: .85; }
.${ERROR_CLASS}::before { content: "\\26a0  "; }
[${ORIGINAL_HIDDEN_ATTR}="hidden"] { display: none !important; }
`;

/** 内联标记还原钩子（P0-8 inline-markup 注入）：把含 `[[n]]` 占位符的译文还原成 DOM 节点。 */
export type MarkupRestorer = (translated: string) => Node[];

export interface RenderOptions {
  /** 显示模式，默认 bilingual。 */
  displayMode?: DisplayMode;
  /** 译文样式预设，默认 normal。 */
  style?: TranslationStyle;
  /** inline-markup 还原钩子；未提供则降级纯文本。 */
  restoreMarkup?: MarkupRestorer;
}

/** 渲染句柄：持有 wrapper 引用，支持后续切换 / 流式 / 错误 / 移除。 */
export interface RenderHandle {
  readonly id: string;
  readonly wrapper: HTMLElement;
  /** 插入目标（供 LayoutGuard.watch 使用）。 */
  readonly target: InsertionTarget;

  /** 切换显示模式（原文 / 译文 / 双显）。 */
  setDisplayMode(mode: DisplayMode): void;
  /** 切换译文样式预设。 */
  setStyle(style: TranslationStyle): void;
  /** 流式追加（P1）：累加 chunk 到译文。 */
  appendChunk(chunk: string): void;
  /** 替换整段译文（重译 / 缓存命中回填）。 */
  setText(translated: string): void;
  /** 标记失败，显示原位错误占位（不影响其他段）。 */
  markError(reason: string): void;
  /** 清除错误占位，恢复显示当前译文。 */
  clearError(): void;
  /** 移除译文 wrapper（调用方负责同步 layout-guard.unwatch）。 */
  remove(): void;
}

/**
 * 确保运行时样式表只注入一次。
 * 幂等：重复调用无副作用。
 */
export function ensureStyles(doc: Document = document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
}

/** 默认还原器：纯文本节点（`[[n]]` 占位符原样保留，待 P0-8 接入）。 */
function defaultRestorer(text: string): Node[] {
  return [document.createTextNode(text)];
}

/** 用还原器（或默认）填充 wrapper 内容。 */
function fillContent(wrapper: HTMLElement, text: string, restorer: MarkupRestorer): void {
  wrapper.replaceChildren(...restorer(text));
}

/** 应用译文样式预设（先清旧再加新）。 */
function applyStyle(wrapper: HTMLElement, style: TranslationStyle): void {
  for (const cls of Object.values(STYLE_CLASSES)) {
    if (cls) wrapper.classList.remove(cls);
  }
  const cls = STYLE_CLASSES[style];
  if (cls) wrapper.classList.add(cls);
}

/**
 * 应用显示模式。
 *
 * 严格遵循「不改动原节点」：默认 render 不触碰原节点；仅当显式切换到
 * 'translation'（仅译文）时，给原节点加可逆的 data-bt-original 属性隐藏原文，
 * 切回时移除 —— 这是架构 ui.showOriginal 的预期视图行为。
 */
function applyDisplayMode(
  wrapper: HTMLElement,
  original: HTMLElement,
  mode: DisplayMode,
): void {
  wrapper.classList.toggle(HIDDEN_CLASS, mode === 'original');
  if (mode === 'translation') {
    original.setAttribute(ORIGINAL_HIDDEN_ATTR, 'hidden');
  } else if (original.getAttribute(ORIGINAL_HIDDEN_ATTR) === 'hidden') {
    original.removeAttribute(ORIGINAL_HIDDEN_ATTR);
  }
}

function errorLabel(reason: string): string {
  return `翻译失败：${reason}`;
}

/**
 * 渲染译文：在原段落节点后插入 wrapper（容器感知），不改原节点任何属性 / 类 / style。
 *
 * @returns RenderHandle，持有 wrapper 供后续操作与 layout-guard 监听。
 */
export function render(
  paragraph: Paragraph,
  translated: string,
  options: RenderOptions = {},
): RenderHandle {
  ensureStyles();

  const displayMode = options.displayMode ?? 'bilingual';
  const style = options.style ?? 'normal';
  const restorer = options.restoreMarkup ?? defaultRestorer;

  const wrapper = document.createElement('div');
  wrapper.className = BASE_CLASS;
  wrapper.dataset.btId = paragraph.id;
  wrapper.setAttribute('data-bt-translation', '');

  fillContent(wrapper, translated, restorer);
  applyStyle(wrapper, style);

  const target = resolveInsertionPoint(paragraph.node!);
  applyDisplayMode(wrapper, paragraph.node!, displayMode);

  // 插入 DOM —— 此处绝不触碰 paragraph.node 的属性 / 类 / style。
  insertWrapper(target, wrapper);

  let buffer = translated;
  let errored = false;

  return {
    id: paragraph.id,
    wrapper,
    target,
    setDisplayMode(mode) {
      applyDisplayMode(wrapper, paragraph.node!, mode);
    },
    setStyle(s) {
      applyStyle(wrapper, s);
    },
    appendChunk(chunk) {
      buffer += chunk;
      if (!errored) fillContent(wrapper, buffer, restorer);
    },
    setText(next) {
      buffer = next;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      fillContent(wrapper, next, restorer);
    },
    markError(reason) {
      errored = true;
      wrapper.classList.add(ERROR_CLASS);
      wrapper.replaceChildren(document.createTextNode(errorLabel(reason)));
    },
    clearError() {
      if (!errored) return;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      fillContent(wrapper, buffer, restorer);
    },
    remove() {
      wrapper.remove();
    },
  };
}

/**
 * 渲染失败段落的原位错误占位（不阻塞其他段，每段独立 wrapper）。
 * controller 收到 ERROR 消息时调用，或对 render 返回的 handle 调 markError。
 */
export function renderError(
  paragraph: Paragraph,
  reason: string,
  options?: Pick<RenderOptions, 'displayMode'>,
): RenderHandle {
  const handle = render(paragraph, '', options);
  handle.markError(reason);
  return handle;
}
