/**
 * PDF 文本层提取器 —— src/content/pdf/text-layer-extractor.ts（P2-1 / TRA-24）。
 *
 * 见 docs/ARCHITECTURE.md 第 8 节 P2 项：用 pdf.js 渲染 PDF 并提取文本层，复用 P0/P1
 * 批量翻译协议对文本层段落翻译，双语对照叠加在 pdf.js 渲染层上。
 *
 * 本文件是 P2-1 的核心纯函数交付物：从 pdf.js 渲染产出的文本层（`.textLayer` 内若干
 * 绝对定位 `<span>`，每个 span = 一个 pdf.js text item）聚合为「段落」，分配稳定
 * `paragraphId`，供翻译编排器入队。
 *
 * ── 段落聚合策略（复用 P0 DOM 提取器）─────────────────────────────────────
 * P0 dom-walker 的段落策略：按文档顺序枚举块级候选 → 序列化 → 分类 → 分配稳定 id
 * （`hashId(order, text)`，规范化文本 + FNV-1a 哈希）→ 去重。PDF 文本层没有语义块级
 * 标签（全是 span），无法靠 tag 判段落，故改为「按几何位置聚合」：
 *   1. text item → 行（同一基线 top 在 lineTolerance 内的 item 归为同一行，按 left 排序）；
 *   2. 行 → 段落（相邻行垂直间距 ≤ paragraphGap 阈值归为同段，超过则断段）；
 *   3. 段落文本 = 各行文本用空格 / 换行连接（CJK 之间不留空格，避免翻译噪声）；
 *   4. 稳定 id 复用 `hashId(order, text)`（与 P0 同算法）；`order` 为跨页全局递增计数，
 *      故**每个文本出现位置**（含跨页重复的页眉/页脚）都拿到独立 id → 独立 overlay。
 *      重复文本的「翻译去重」交给 orchestrator 缓存（同 source → 同 cacheKey → 命中免请求），
 *      本层不做文本去重，确保每个出现位置都有自己的译文 overlay。
 *
 * 纯函数边界：聚合算法 `extractPdfParagraphs(items, opts)` 只依赖传入的 `PdfTextItem[]`
 * （text + 几何 rect），不碰 DOM、不碰浏览器 API，可在 jsdom / Node 单测中覆盖。DOM 适配
 * `collectTextItems(root)` 单独导出，负责把 `.textLayer` 的 span 读成 `PdfTextItem[]`。
 *
 * ── 扫描版 PDF（无文本层）─────────────────────────────────────────────────
 * 扫描版 PDF 的 `.textLayer` 为空或全空 item → `extractPdfParagraphs` 返回 `[]`，
 * 由上层（pdf-controller）走 P2-3 OCR 兜底，不在本 issue 实现（架构第 8 节 / 任务约束）。
 */
import type { Item } from '../../shared/types';
import { hashId } from '../extractor/dom-walker';

/** pdf.js 文本层中一个 text item 的几何 + 文本（DOM 无关，可结构化克隆 / 单测）。 */
export interface PdfTextItem {
  /** 该 item 的文本（已 trim 尾部空白，保留内部）。 */
  text: string;
  /** 相对所属 `.textLayer` 容器的左上角 x（px）。 */
  left: number;
  /** 相对所属 `.textLayer` 容器的左上角 y（px）。 */
  top: number;
  /** item 宽（px）。 */
  width: number;
  /** item 高（px），用作行高近似。 */
  height: number;
  /**
   * 原始 span DOM 引用 —— 仅 content 侧持有，绝不跨 chrome 边界传递。
   * 聚合算法不依赖它；保留供 overlay 渲染层定位 / 重新挂载用。
   */
  element?: HTMLElement;
}

/** 段落几何矩形（相对 `.textLayer` 容器，px）。 */
export interface PdfRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** PDF 文本层聚合产出的段落。 */
export interface PdfParagraph {
  /** 稳定 id（复用 P0 hashId）。 */
  id: string;
  /** 段落原文（行间以换行连接，行内 item 间按需空格）。 */
  text: string;
  /** 段落并集矩形，供 overlay wrapper 绝对定位。 */
  rect: PdfRect;
  /** 段落包含的 text item（保留 element 引用供 overlay 重新定位）。 */
  items: PdfTextItem[];
  /** 所属页索引（0 基），多页 PDF 时由上层按页聚合后合并。 */
  page: number;
}

/** 聚合可调阈值。 */
export interface ExtractPdfOptions {
  /**
   * 行归并容差：两 item 的 `top` 差 ≤ 该值视为同一行。默认取 item 高度的一半，
   * 传 0 则严格按 top 相等归行。单位 px。
   */
  lineTolerance?: number;
  /**
   * 段落断行阈值：相邻两行垂直间距（下行 top − 上行 bottom）> 该值则断为新段。
   * 默认 0.8 × 行高；传 Infinity 则所有行合并为一段（单段文档）。
   */
  paragraphGap?: number;
  /**
   * 是否跳过「页码样」item：行内仅 1~3 个字符且全数字、位于页面底部 12% 区域。
   * 默认 true（避免把页码当段落翻译）。
   */
  skipPageNumbers?: boolean;
}

/** 默认行高兜底（item.height 异常为 0 时用），px。 */
const DEFAULT_LINE_HEIGHT = 16;

/** 单字符 CJK 判定（用于行内连接时决定是否插空格）。用 unicode 转义避免不规则空白。 */
const CJK_RE = /[一-鿿㐀-䶿＀-￯　-〿]/;

function isCjk(ch: string | undefined): boolean {
  return !!ch && CJK_RE.test(ch);
}

/** 规范化 item 文本：折叠内部空白为单空格，去首尾空白。 */
function normalizeItemText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 两段文本连接：CJK 之间不留空格，其余用单空格连接（避免翻译噪声）。 */
function joinText(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const lastA = a[a.length - 1];
  const firstB = b[0];
  if (isCjk(lastA) && isCjk(firstB)) return a + b;
  return a + ' ' + b;
}

/** 行内多 item 按左到右连接为行文本。 */
function lineText(items: PdfTextItem[]): string {
  return items
    .slice()
    .sort((x, y) => x.left - y.left)
    .map((it) => it.text)
    .filter((t) => t.length > 0)
    .reduce(joinText, '');
}

/** 行的并集矩形。 */
function unionRect(items: PdfTextItem[]): PdfRect {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const it of items) {
    left = Math.min(left, it.left);
    top = Math.min(top, it.top);
    right = Math.max(right, it.left + it.width);
    bottom = Math.max(bottom, it.top + it.height);
  }
  return { left, top, right, bottom };
}

/** 行的近似高度（取 item 最大高度，兜底默认值）。 */
function lineHeight(items: PdfTextItem[]): number {
  const maxH = items.reduce((m, it) => Math.max(m, it.height), 0);
  return maxH > 0 ? maxH : DEFAULT_LINE_HEIGHT;
}

interface Line {
  items: PdfTextItem[];
  rect: PdfRect;
  height: number;
}

/** 把 text items 按基线 top 归并为行（同 top 在容差内），并按 top 升序。 */
function groupIntoLines(items: PdfTextItem[], tolerance: number): Line[] {
  const sorted = items.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Line[] = [];
  for (const it of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(it.top - last.rect.top) <= tolerance) {
      last.items.push(it);
      last.rect = unionRect(last.items);
      last.height = lineHeight(last.items);
      continue;
    }
    const items0 = [it];
    lines.push({ items: items0, rect: unionRect(items0), height: lineHeight(items0) });
  }
  return lines;
}

/** 是否页码样 item（行内 1~3 字符全数字，位于页面底部 12%）。 */
function isPageNumberLike(line: Line, pageHeight: number): boolean {
  if (pageHeight <= 0) return false;
  const text = lineText(line.items).trim();
  if (text.length === 0 || text.length > 3) return false;
  if (!/^\d+$/.test(text)) return false;
  // 位于页面底部 12% 区域。
  return line.rect.top > pageHeight * 0.88;
}

/**
 * 把已归并的行序列按垂直间距断为段落。
 * gap = 下行 top − 上行 bottom；gap > paragraphGap 则断段。
 *
 * `order` 由调用方传入的可变计数器维护，跨页全局递增 → 每个文本出现位置拿独立 id。
 */
function groupLinesIntoParagraphs(
  lines: Line[],
  paragraphGap: number,
  page: number,
  counter: { value: number },
): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = [];
  let cur: Line[] = [];

  const flush = (): void => {
    if (cur.length === 0) return;
    const items = cur.flatMap((l) => l.items);
    const text = cur.map((l) => lineText(l.items)).filter((t) => t.length > 0).join('\n');
    if (text.trim().length === 0) {
      cur = [];
      return;
    }
    const id = hashId(counter.value, text);
    counter.value += 1;
    paragraphs.push({ id, text, rect: unionRect(items), items, page });
    cur = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const prev = lines[i - 1];
    if (prev && cur.length > 0) {
      const gap = line.rect.top - prev.rect.bottom;
      if (gap > paragraphGap) flush();
    }
    cur.push(line);
  }
  flush();
  return paragraphs;
}

/**
 * 从一页 pdf.js 文本层 items 聚合段落（纯函数）。
 *
 * @param items 一页 `.textLayer` 内全部 text item（已含几何）
 * @param pageHeight 该页文本层容器高度（用于页码样 item 检测）；≤0 则跳过该检测
 * @param page 页索引（0 基），写入产物 `PdfParagraph.page`
 * @param opts 阈值选项
 * @param counter 跨页共享的全局递增计数器（决定 id 中的 order）；单页调用可省略
 * @returns 该页段落数组（可能为空 = 空文本层 / 扫描版）
 */
export function extractPdfParagraphs(
  items: PdfTextItem[],
  pageHeight: number,
  page: number,
  opts: ExtractPdfOptions = {},
  counter?: { value: number },
): PdfParagraph[] {
  const lineTol = opts.lineTolerance ?? 0;
  const skipPageNumbers = opts.skipPageNumbers ?? true;
  const ctr = counter ?? { value: 0 };

  // 1. 过滤空文本 item，规范化。
  const normItems = items
    .map((it) => ({ ...it, text: normalizeItemText(it.text) }))
    .filter((it) => it.text.length > 0);
  if (normItems.length === 0) return [];

  // 2. 行归并。容差默认取 item 高度一半——但整体统一用最大行高的一半更稳。
  const approxH = normItems.reduce((m, it) => Math.max(m, it.height), 0) || DEFAULT_LINE_HEIGHT;
  const tol = lineTol > 0 ? lineTol : approxH * 0.5;
  const lines = groupIntoLines(normItems, tol);

  // 3. 过滤页码样行。
  const filtered = skipPageNumbers ? lines.filter((l) => !isPageNumberLike(l, pageHeight)) : lines;

  // 4. 段落断行阈值：默认 0.8 × 行高。
  const gap = opts.paragraphGap ?? approxH * 0.8;
  return groupLinesIntoParagraphs(filtered, gap, page, ctr);
}

/**
 * 多页聚合：对每页 items 调 `extractPdfParagraphs` 后合并，共享一个全局递增计数器，
 * 使每个文本出现位置（含跨页重复的页眉/页脚）拿到独立 id → 独立 overlay。
 * 重复文本的翻译去重由 orchestrator 缓存承担（同 source → 同 cacheKey → 命中免请求）。
 */
export function extractPdfParagraphsMultiPage(
  pages: Array<{ items: PdfTextItem[]; pageHeight: number; page: number }>,
  opts: ExtractPdfOptions = {},
): PdfParagraph[] {
  const counter = { value: 0 };
  const out: PdfParagraph[] = [];
  for (const p of pages) {
    out.push(...extractPdfParagraphs(p.items, p.pageHeight, p.page, opts, counter));
  }
  return out;
}

/** 把 `PdfParagraph[]` 投影为翻译协议 `Item[]`（仅 id + text，跨 chrome 边界安全）。 */
export function toItems(paragraphs: PdfParagraph[]): Item[] {
  return paragraphs.map((p) => ({ id: p.id, text: p.text }));
}

// ─────────────────────────────────────────────────────────────────────────
// DOM 适配：从 `.textLayer` 读取 span → PdfTextItem[]
// ─────────────────────────────────────────────────────────────────────────

/**
 * pdf.js 文本层 span 选择器。pdf.js v4+ 渲染每个 text item 为 `<span>`（绝对定位，
 * `role="presentation"`），位于 `.textLayer` 容器内。
 */
const PDF_TEXT_SPAN_SELECTOR = '.textLayer span, [role="presentation"]';

/**
 * 读取相对容器的偏移：优先用 offsetLeft/offsetTop（相对 offsetParent = 容器），
 * 退化到 getBoundingClientRect 相对容器 rect。
 */
function readOffset(span: HTMLElement, container: Element): { left: number; top: number; width: number; height: number } {
  // offsetParent 即 container 时直接用 offset*（最快、不受 transform 累计影响）。
  if (span.offsetParent === container) {
    return {
      left: span.offsetLeft,
      top: span.offsetTop,
      width: span.offsetWidth || span.getBoundingClientRect().width,
      height: span.offsetHeight || span.getBoundingClientRect().height,
    };
  }
  const cr = container.getBoundingClientRect();
  const r = span.getBoundingClientRect();
  return {
    left: r.left - cr.left,
    top: r.top - cr.top,
    width: r.width,
    height: r.height,
  };
}

/**
 * 从一个 pdf.js `.textLayer` 容器读取 text items（DOM 适配，非纯函数）。
 *
 * pdf.js 把每个 text item 渲染为绝对定位 span，文本在 span 的 textContent 里（可能含
 * 换行 `<br>`，这里用 innerText 取可见文本，无 innerText 时回退 textContent）。
 *
 * @param container 一页的 `.textLayer` 元素
 * @returns 该页 text items（含 element 引用，供 overlay 定位）
 */
export function collectTextItems(container: Element): PdfTextItem[] {
  const spans = Array.from(
    container.matches(PDF_TEXT_SPAN_SELECTOR.split(',')[0]!.trim())
      ? [container as HTMLElement]
      : [],
  ).concat(Array.from(container.querySelectorAll<HTMLElement>(PDF_TEXT_SPAN_SELECTOR)));

  const seen = new Set<HTMLElement>();
  const items: PdfTextItem[] = [];
  for (const span of spans) {
    if (seen.has(span)) continue;
    seen.add(span);
    const text = (span.innerText ?? span.textContent ?? '');
    if (!text.trim()) continue;
    const { left, top, width, height } = readOffset(span, container);
    items.push({ text, left, top, width, height, element: span });
  }
  return items;
}

/** 读取 `.textLayer` 容器高度（页码样检测用）。无 DOM 时返回 0（跳过页码检测）。 */
export function readPageHeight(container: Element): number {
  const htmlEl = container as HTMLElement;
  if (htmlEl.offsetHeight) return htmlEl.offsetHeight;
  if (typeof getComputedStyle === 'function') {
    const h = Number.parseFloat(getComputedStyle(htmlEl).height);
    if (Number.isFinite(h) && h > 0) return h;
  }
  return container.getBoundingClientRect().height || 0;
}
