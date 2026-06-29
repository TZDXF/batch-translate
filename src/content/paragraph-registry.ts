import type { Paragraph } from '../shared/types';

/**
 * 段落翻译状态。
 * - pending：已登记，等待翻译
 * - translating：已下发，等待结果
 * - streaming：流式接收中（P1）
 * - translated：已回填译文
 * - error：翻译失败（显示原位错误占位）
 */
export type ParagraphStatus =
  | 'pending'
  | 'translating'
  | 'streaming'
  | 'translated'
  | 'error';

/**
 * 段落登记项 —— paragraphId ↔ DOM 节点引用 的映射载体。
 * controller 收到 SW 的 RESULT / ERROR / STREAM_CHUNK 消息后，凭 id 查到该项，
 * 取 node / wrapper 做回填。详见架构 2.1「段落状态映射」。
 */
export interface ParagraphEntry {
  /** 段落 id（与 Paragraph.id 一致） */
  id: string;
  /** 原段落 DOM 节点引用 */
  node: HTMLElement;
  /** 原文纯文本 */
  sourceText: string;
  /** 注入的译文 wrapper 节点（render 后赋值，未渲染时为 undefined） */
  wrapper: HTMLElement | undefined;
  /** 当前翻译状态 */
  status: ParagraphStatus;
  /** 失败原因（status === 'error' 时有意义） */
  errorReason: string | undefined;
}

/**
 * ParagraphRegistry —— 持有当前页面所有已提取段落的 DOM 映射。
 *
 * content script 单例。提取器产出 Paragraph[] → register；渲染器注入 wrapper →
 * setWrapper；controller 按翻译结果回填 → setStatus。页面卸载 / 关闭翻译时 clear。
 */
export class ParagraphRegistry {
  private readonly map = new Map<string, ParagraphEntry>();

  /** 登记单个段落（已存在则保留 wrapper / 状态，仅刷新 node / sourceText）。 */
  register(paragraph: Paragraph): ParagraphEntry {
    const existing = this.map.get(paragraph.id);
    if (existing) {
      existing.node = paragraph.node!;
      existing.sourceText = paragraph.text;
      return existing;
    }
    const entry: ParagraphEntry = {
      id: paragraph.id,
      node: paragraph.node!,
      sourceText: paragraph.text,
      wrapper: undefined,
      status: 'pending',
      errorReason: undefined,
    };
    this.map.set(paragraph.id, entry);
    return entry;
  }

  /** 批量登记。 */
  registerMany(paragraphs: readonly Paragraph[]): void {
    for (const p of paragraphs) this.register(p);
  }

  /** 按 id 查询。 */
  get(id: string): ParagraphEntry | undefined {
    return this.map.get(id);
  }

  /** 是否已登记。 */
  has(id: string): boolean {
    return this.map.has(id);
  }

  /** 记录渲染器注入的 wrapper 引用。 */
  setWrapper(id: string, wrapper: HTMLElement): void {
    const entry = this.map.get(id);
    if (entry) entry.wrapper = wrapper;
  }

  /** 更新翻译状态（含可选失败原因）。 */
  setStatus(id: string, status: ParagraphStatus, errorReason?: string): void {
    const entry = this.map.get(id);
    if (!entry) return;
    entry.status = status;
    if (errorReason !== undefined) entry.errorReason = errorReason;
    if (status !== 'error') entry.errorReason = undefined;
  }

  /** 全部登记项迭代器。 */
  entries(): IterableIterator<ParagraphEntry> {
    return this.map.values();
  }

  /** 已登记段落数。 */
  get size(): number {
    return this.map.size;
  }

  /** 移除单个段落登记（及其引用）。 */
  remove(id: string): void {
    this.map.delete(id);
  }

  /** 清空全部登记。 */
  clear(): void {
    this.map.clear();
  }
}
