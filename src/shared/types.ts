// 共享类型。详见 docs/ARCHITECTURE.md §3（目录结构）/ §6（数据模型）。
// Stage 1 仅占位骨架，具体字段在后续 issue 填充。

/** 段落分类（block-classifier 产出）。 */
export type BlockType = 'content' | 'navigation' | 'code' | 'skip';

/** 可翻译段落（DOM 提取器产出，paragraphId 与 DOM 映射见 paragraph-registry）。 */
export interface Paragraph {
  id: string;
  text: string;
  blockType: BlockType;
}

/** 翻译条目：批量协议请求/响应中的单段（见 §4.2）。 */
export interface TranslationItem {
  id: string;
  text: string;
}

/** 一批待翻译条目（packer 产出）。 */
export interface Batch {
  id: string;
  items: TranslationItem[];
}
