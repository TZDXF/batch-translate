/**
 * 内联标记占位符保护 — src/content/extractor/inline-markup.ts
 *
 * 见 docs/ARCHITECTURE.md 第 4.3 节（占位符 `[[n]]` verbatim 约束）与第 9 节
 * （「内联标签回填错位」风险对策）。
 *
 * 思路：把块级元素里的内联标签（a / strong / em / code / sup …）整体替换为不透明
 * 占位符 `[[n]]`，标签 + 其内部文本作为一个整体随译文移动，从根上避免 LLM 重排导致
 * 的标签错位。占位符结构支持嵌套（内层标签收纳在父占位符的 children 中）。
 *
 * - `serialize(node)`：产出 `{ text, placeholders }` —— text 含 `[[n]]`，发给 LLM。
 * - `restore(translatedText, placeholders)`：按占位符重建内联 DOM，返回 DocumentFragment。
 *
 * 限制（MVP）：内联标签内部文本随标签作为不透明 token 一并保留、不单独翻译；这是
 * 「verbatim + 数量校验一致」的稳健取舍，逐标签翻译留待后续优化。
 */

import type { Placeholder, PlaceholderNode, SerializedInline } from '../../shared/types';

/** 占位符 token 的正则：`[[数字]]`。 */
export const PLACEHOLDER_RE = /\[\[(\d+)\]\]/g;

/**
 * 视为「内联、需占位符保护」的标签集合。
 * 纯样式标签（strong/em/u/s/mark/sub/sup…）与结构性内联（a/code/img/br…）都纳入，
 * 以保证回填后样式与结构完整。
 */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins',
  'mark', 'small', 'sub', 'sup', 'code', 'kbd', 'samp', 'var', 'cite',
  'q', 'abbr', 'time', 'span', 'label', 'font', 'bdi', 'bdo',
  'br', 'img', 'wbr',
]);

/** 判断元素是否属于需占位符保护的内联标签。 */
export function isInlineElement(el: Element): boolean {
  return INLINE_TAGS.has(el.tagName.toLowerCase());
}

/** 读取元素属性为有序键值对数组（保留出现顺序，便于回填）。 */
function readAttrs(el: Element): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const attr of Array.from(el.attributes)) {
    out.push([attr.name, attr.value]);
  }
  return out;
}

/** 占位符子内容：字面文本段 与 嵌套占位符引用 `{ ph }` 的混合。 */
type ChildPart = string | { ph: number };

/** 合并相邻字面文本段，减少碎片。 */
function mergeAdjacentStrings(arr: ChildPart[]): ChildPart[] {
  const out: ChildPart[] = [];
  for (const item of arr) {
    if (typeof item === 'string' && out.length && typeof out[out.length - 1] === 'string') {
      (out[out.length - 1] as string) += item;
    } else {
      out.push(item);
    }
  }
  return out;
}

/**
 * 把一个内联元素压成占位符并返回其序号。
 *
 * 关键：`index` 在递归子节点「之前」就捕获（`placeholders.length`），因此外层元素
 * 拿到更小的序号 —— 与其在 text 中的出现顺序一致；序号全程唯一，无需重映射。
 */
function createPlaceholder(el: Element, placeholders: Placeholder[]): number {
  const index = placeholders.length;
  // 先入栈占位（占住序号），再递归填 children —— 保证外层序号 < 内层序号，
  // 与占位符在 text / children 中的出现顺序一致，序号全程唯一、无需重映射。
  const node: PlaceholderNode = {
    tag: el.tagName.toLowerCase(),
    attrs: readAttrs(el),
    children: [],
  };
  placeholders.push({ index, node });
  const childParts: ChildPart[] = [];
  // 内联元素内部用 { ph } 引用嵌套占位符（而非 [[n]] token）。
  walkChildren(el, childParts, placeholders, 'ref');
  node.children = mergeAdjacentStrings(childParts);
  return index;
}

/**
 * 遍历父节点的子节点，按规则写入 parts：
 * - 文本节点 → 字面字符串；
 * - 内联元素 → 先压成占位符，再把 `[[n]]` 写入（顶层 serialize 用）或 `{ ph }` 写入
 *   （占位符内部 children 用，由 mode 区分）；
 * - 非内联元素 → 扁平化递归（其文本纳入流、其内联子节点照常保护）。
 */
function walkChildren(
  parent: Element,
  parts: Array<string | { ph: number }>,
  placeholders: Placeholder[],
  mode: 'token' | 'ref',
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === 3 /* Node.TEXT_NODE */) {
      const t = child.nodeValue ?? '';
      if (t) parts.push(t);
    } else if (child.nodeType === 1 /* Node.ELEMENT_NODE */) {
      const el = child as Element;
      if (INLINE_TAGS.has(el.tagName.toLowerCase())) {
        const ph = createPlaceholder(el, placeholders);
        parts.push(mode === 'token' ? `[[${ph}]]` : { ph });
      } else {
        // 非内联子元素（少见，如块级包裹）：扁平化，文本纳入流、内联子节点照常保护。
        walkChildren(el, parts, placeholders, mode);
      }
    }
    // 注释 / 处理指令等忽略。
  }
}

/**
 * 序列化块级元素为 `{ text, placeholders }`。
 *
 * 顶层文本流由「直接文本节点」与「内联元素占位符 `[[n]]`」按文档顺序拼接；嵌套内联
 * 元素收纳在其父占位符内，不在顶层 text 中出现。
 */
export function serialize(node: Element): SerializedInline {
  const placeholders: Placeholder[] = [];
  const parts: string[] = [];
  walkChildren(
    node,
    parts as Array<string | { ph: number }>,
    placeholders,
    'token',
  );
  return { text: parts.join(''), placeholders };
}

/**
 * 按占位符结构重建单个内联元素（递归处理 children 中的嵌套引用）。
 */
function buildPlaceholderElement(
  ph: Placeholder,
  placeholders: Placeholder[],
  doc: Document,
): Element {
  const el = doc.createElement(ph.node.tag);
  for (const [name, value] of ph.node.attrs) {
    el.setAttribute(name, value);
  }
  for (const child of ph.node.children) {
    if (typeof child === 'string') {
      el.appendChild(doc.createTextNode(child));
    } else {
      const nested = placeholders[child.ph];
      if (nested) {
        el.appendChild(buildPlaceholderElement(nested, placeholders, doc));
      }
    }
  }
  return el;
}

/**
 * 把含 `[[n]]` 占位符的文本回填为内联 DOM 片段。
 *
 * 扫描 translatedText，把字面文本与占位符按顺序写入 DocumentFragment；找不到对应
 * 占位符的 token 原样保留为文本（LLM 偶发改动占位符时不崩，仅降级为字面量）。
 *
 * `doc` 用于 ownerDocument（便于测试注入），缺省用当前 document。
 */
export function restore(
  translatedText: string,
  placeholders: Placeholder[],
  doc: Document = document,
): DocumentFragment {
  const frag = doc.createDocumentFragment();
  let last = 0;
  for (const match of translatedText.matchAll(PLACEHOLDER_RE)) {
    const idx = Number(match[1]);
    const start = match.index ?? 0;
    if (start > last) frag.appendChild(doc.createTextNode(translatedText.slice(last, start)));
    const ph = placeholders[idx];
    if (ph) {
      frag.appendChild(buildPlaceholderElement(ph, placeholders, doc));
    } else {
      // 占位符缺失：原样保留，维持可读。
      frag.appendChild(doc.createTextNode(match[0]));
    }
    last = start + match[0].length;
  }
  if (last < translatedText.length) {
    frag.appendChild(doc.createTextNode(translatedText.slice(last)));
  }
  return frag;
}

/** 统计占位符数量（用于回填后「内联标签数量一致」校验）。 */
export function countInlineTags(placeholders: Placeholder[]): number {
  return placeholders.length;
}
