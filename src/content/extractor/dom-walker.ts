/**
 * DOM 提取器 — src/content/extractor/dom-walker.ts
 *
 * 见 docs/ARCHITECTURE.md 第 3 节（模块划分）、第 4.3 节（占位符契约）、第 9 节
 * （「排版破坏」只读提取、「SPA 动态加载」段落去重）。
 *
 * `extract(root): Paragraph[]`：在正文区域内找块级文本段落，分配稳定 `paragraphId`，
 * 序列化内联标记为 `[[n]]` 占位符，分类，去重。全程**只读**——不改动任何节点属性。
 */

import type { BlockCategory, Paragraph } from '../../shared/types';
import { classify } from './block-classifier';
import { isInlineElement, serialize } from './inline-markup';

export interface ExtractOptions {
  /** 是否翻译导航类内容（透传给 block-classifier，默认 false）。 */
  translateNav?: boolean;
  /** 额外强制跳过的选择器（用户黑名单等）。 */
  skipSelectors?: string[];
}

/** 候选块级元素：含直接文本即可能成为段落。 */
const BLOCK_SELECTOR = [
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'li',
  'blockquote', 'td', 'th', 'dd', 'dt', 'figcaption', 'caption', 'summary',
  'div', 'address',
].join(',');

/** 提取时整体跳过的标签（不可译 / 非文本）。 */
const SKIP_TAGS = 'script, style, noscript, code, pre, template, svg, math, iframe, canvas, object, embed, video, audio, map, area';

/** 表单 / 可编辑控件。 */
const FORM_FIELDS = 'input, textarea, select, button, option, optgroup, fieldset, [contenteditable]';

/** 已注入译文的标记（避免重复注入，与渲染器 TRA-9 约定）。 */
const TRANSLATED_MARK = '[data-bt-paragraph-id], .bt-translation, [data-bt-skip]';

/** FNV-1a 32-bit 哈希（快、稳定、不依赖 Web Crypto，可在 jsdom 中跑）。 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.codePointAt(i)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 稳定段落 id：文档顺序 + 规范化文本哈希。
 * 规范化（折叠空白）保证纯空白差异不改变 id，提取可复现。
 */
export function hashId(order: number, text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  return 'bt_' + fnv1a(`${order}${norm}`).toString(36);
}

/** 选正文区域：优先 main / [role=main] / article，否则用传入根。 */
function selectContentRoot(root: Element): Element {
  return root.querySelector('main, [role="main"], article') ?? root;
}

/** 是否隐藏（不译）。依赖 hidden 属性 / aria-hidden / 内联 display|visibility。 */
function isHidden(el: Element): boolean {
  const htmlEl = el as HTMLElement;
  if (htmlEl.hidden) return true;
  if (el.getAttribute('aria-hidden') === 'true') return true;
  if (el.closest('[aria-hidden="true"]')) return true;
  // 内联样式检测（jsdom 不应用外部样式表，真实浏览器覆盖更全）。
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(htmlEl) : null;
  if (style) {
    const display = style.getPropertyValue('display');
    const visibility = style.getPropertyValue('visibility');
    if (display === 'none' || visibility === 'hidden') return true;
  }
  return false;
}

/** 是否应整体跳过（代码 / 脚本 / 表单 / 可编辑 / 已翻译 / 隐藏 / 用户黑名单）。 */
function isSkippable(el: Element, skipSel: string[]): boolean {
  if (el.closest(SKIP_TAGS)) return true;
  if (el.closest(FORM_FIELDS)) return true;
  if (el.closest(TRANSLATED_MARK)) return true;
  if (isHidden(el)) return true;
  for (const sel of skipSel) {
    try {
      if (el.matches(sel)) return true;
    } catch {
      // 非法选择器忽略。
    }
  }
  return false;
}

/**
 * 叶子块判定：元素是否含「直接文本」（文本节点或内联子元素），而非只是包裹其他块。
 * 用于避免 `<div><p>…</p></div>` 这类包裹容器与子段落重复提取。
 */
function hasDirectTextContent(el: Element): boolean {
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) {
      if ((child.nodeValue ?? '').trim()) return true;
    } else if (child.nodeType === 1 /* Node.ELEMENT_NODE */) {
      if (isInlineElement(child as Element)) return true;
      // 非内联子元素：包裹的块，不计入。
    }
  }
  return false;
}

/**
 * 从 root 提取可翻译段落。
 *
 * 流程：选正文区 → 枚举块级候选 → 跳过不可译 → 叶子块判定 → 序列化（占位符保护）
 *      → 分类 → 分配稳定 id → 去重 → 输出 Paragraph[]。
 */
export function extract(root: Element, opts: ExtractOptions = {}): Paragraph[] {
  const translateNav = opts.translateNav ?? false;
  const skipSelectors = opts.skipSelectors ?? [];

  const scope = selectContentRoot(root);
  const candidates = Array.from(scope.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));

  const seenElements = new WeakSet<Element>();
  const seenIds = new Set<string>();
  const paragraphs: Paragraph[] = [];
  let order = 0;

  for (const el of candidates) {
    if (seenElements.has(el)) continue;
    if (isSkippable(el, skipSelectors)) continue;
    if (!hasDirectTextContent(el)) continue;

    const { text, placeholders } = serialize(el);
    if (!text.trim()) continue;

    const category: BlockCategory = classify(el, { translateNav });
    if (category === 'skip') continue;

    const id = hashId(order, text);
    if (seenIds.has(id)) continue;

    seenElements.add(el);
    seenIds.add(id);
    paragraphs.push({ id, element: el, text, category, placeholders });
    order += 1;
  }

  return paragraphs;
}
