/**
 * 段落分类 — src/content/extractor/block-classifier.ts
 *
 * 见 docs/ARCHITECTURE.md 第 3 节（DOM 提取器职责）。
 *
 * 把块级元素标注为四类之一，决定是否进入翻译：
 * - `content`：正文，翻译；
 * - `nav`：导航 / 页眉页脚 / 链接列表，按配置决定是否翻译；
 * - `code`：代码块，不译；
 * - `skip`：过短 / 纯符号 / URL 等不可译内容，跳过。
 *
 * 纯启发式、可单测，不依赖翻译引擎。
 */

import type { BlockCategory } from '../../shared/types';

export interface ClassifyOptions {
  /** 是否翻译导航类内容（默认 false，导航不译）。 */
  translateNav?: boolean;
  /** 文本短于此字符数视为不可译（默认 2）。 */
  minChars?: number;
}

/** 形如代码的 class 特征（语法高亮 / 代码块容器）。 */
const CODE_CLASS_RE = /(^|\s)(language-|hljs|highlight|shiki|codehilite|code-block|codeblock|prism|CodeMirror|rouge)([-\w]*)?/i;

/** 纯标点 / 符号 / 数字 / 空白（Unicode），无任何字母 → 不可译。 */
const NON_VERBAL_RE = /^[\s\p{P}\p{S}\d]+$/u;

/** 形似 URL。 */
const URL_RE = /^\s*(https?|ftp|mailto|tel):/i;

/** 导航类祖先选择器。 */
const NAV_ANCESTOR = 'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"]';

/** 判断元素位于导航 / 页眉页脚区域内。 */
export function isNav(el: Element): boolean {
  if (el.closest(NAV_ANCESTOR)) return true;
  if (el.getAttribute('role') === 'navigation') return true;
  // 链接列表：ul/ol/nav 且大多数直接子项含 <a>。
  const tag = el.tagName.toLowerCase();
  if (tag === 'ul' || tag === 'ol' || tag === 'nav') {
    return isLinkList(el);
  }
  return false;
}

/** ul/ol 是否主要为链接列表（≥60% 直接 li 子项含链接）。 */
function isLinkList(el: Element): boolean {
  const items = el.children;
  if (items.length === 0) return false;
  let withLink = 0;
  let counted = 0;
  for (const item of Array.from(items)) {
    const tag = item.tagName.toLowerCase();
    if (tag !== 'li' && tag !== 'a') continue;
    counted++;
    if (tag === 'a' || item.querySelector('a')) withLink++;
  }
  return counted > 0 && withLink / counted >= 0.6;
}

/** 判断元素是（或位于）代码块。 */
export function isCode(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'pre' || tag === 'svg' || tag === 'math') return true;
  if (el.closest('pre, svg, math')) return true;
  const cls = el.getAttribute('class');
  if (cls && CODE_CLASS_RE.test(cls)) return true;
  // 父链上的代码容器 class。
  const codey = el.closest('[class]');
  if (codey) {
    const parentCls = codey.getAttribute('class');
    if (parentCls && CODE_CLASS_RE.test(parentCls)) return true;
  }
  return false;
}

/** 文本是否不可译（过短 / 纯符号 / URL）。 */
export function isLikelyUntranslatable(text: string, minChars = 2): boolean {
  const trimmed = text.trim();
  if (trimmed.length < minChars) return true;
  if (NON_VERBAL_RE.test(trimmed)) return true;
  if (URL_RE.test(trimmed)) return true;
  return false;
}

/**
 * 分类一个块级元素。
 *
 * 判定顺序：code → skip（不可译）→ nav（按配置）→ content。
 * 优先级确保代码与噪声不误入翻译，导航按配置开关。
 */
export function classify(el: Element, opts: ClassifyOptions = {}): BlockCategory {
  const translateNav = opts.translateNav ?? false;
  const minChars = opts.minChars ?? 2;

  if (isCode(el)) return 'code';

  const text = el.textContent ?? '';
  if (isLikelyUntranslatable(text, minChars)) return 'skip';

  if (isNav(el)) return translateNav ? 'content' : 'nav';

  return 'content';
}
