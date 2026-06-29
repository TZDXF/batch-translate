// 引擎列表 / 默认参数常量。详见 docs/ARCHITECTURE.md §1（技术栈）/ §5.3（配置项）。
// Stage 1 仅占位骨架，具体引擎元数据与默认调度参数在后续 issue 填充。

/** 默认目标语言：简体中文。 */
export const DEFAULT_TARGET_LANG = 'zh-CN';

/** 默认源语言：自动检测。 */
export const DEFAULT_SOURCE_LANG = 'auto';

/** 翻译模式。 */
export type TranslateMode = 'basic' | 'agent';

/** 默认翻译模式。 */
export const DEFAULT_MODE: TranslateMode = 'basic';
