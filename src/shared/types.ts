/**
 * BatchTranslate 共享数据类型 —— content script / service worker / popup / options 共用。
 * 字段命名对齐 docs/ARCHITECTURE.md 第 2.2、6.2 节。
 *
 * 本文件只定义可结构化克隆的纯数据结构（能跨 chrome 边界传递），不依赖任何 chrome
 * 运行时 API，也不含 DOM 引用（DOM 引用属于 content 侧 paragraph-registry，不可序列化）。
 */

/** 段落分类（DOM 提取器 block-classifier 产出）。见架构 3 节。 */
export type ParagraphCategory = 'content' | 'navigation' | 'code' | 'skip';

/** DOM 提取器产出的可翻译段落（extract(root): Paragraph[]）。 */
export interface Paragraph {
  /** 段落稳定 id，跨 SW 卸载 / content 重连幂等续传的锚点。 */
  id: string;
  /** 原文。 */
  text: string;
  /** 段落分类，默认按正文处理（提取器产出时填充，渲染层可不关心）。 */
  category?: BlockCategory;
  /**
   * 原段落 DOM 节点引用 —— 仅 content 侧渲染层持有，绝不跨 chrome 边界传递
   * （不可结构化克隆）。SW / popup / options 侧该字段恒为 undefined。
   * 见架构 2.1「段落状态映射」。
   */
  node?: HTMLElement;
  /** 原文块级元素 DOM 引用（提取器产出，只读，渲染器在其后插入译文 wrapper）。 */
  element?: Element;
  /** 内联标记占位符映射，供 restore 回填重建内联 DOM（提取器产出）。 */
  placeholders?: Placeholder[];
}

/** 批量协议的最小翻译单元。见架构 4.2：{id, text}。 */
export interface Item {
  id: string;
  text: string;
}

/** 打包器产出的一个批次。见架构 4.5 pack(items, budget): Batch[]。 */
export interface Batch {
  /** 批次 id，对齐架构 6.2 queue:{[batchId]} 与 Port 消息 BATCH_DONE。 */
  id: string;
  items: Item[];
  /** 本批预估输入 token，供并发 cost 与预算校验。 */
  tokenEstimate: number;
}

/** 单段翻译生命周期状态。对应 Port 消息 PROGRESS{id, status}。 */
export type TranslationStatus =
  | 'pending'
  | 'translating'
  | 'done'
  | 'failed'
  | 'skipped';

/** Tab 级翻译状态。对应一次性消息 STATUS{tabId, state, progress}。 */
export type TabTranslationState = 'idle' | 'translating' | 'done' | 'paused' | 'error';

/** 引擎 provider 枚举。见架构 6.2 engines[].provider。 */
export type EngineProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'openai-compatible';

/** 单个引擎配置（存 storage.local，密钥仅存引用）。见架构 6.2。 */
export interface EngineConfig {
  id: string;
  label: string;
  provider: EngineProvider;
  baseUrl: string;
  model: string;
  enabled: boolean;
  /** ★ secret-store 引用 id，绝不存明文 key。见架构 6.2 / 7.2。 */
  apiKeyRef: string;
  contextWindow: number;
  maxOutput: number;
}

/** 调度参数（options 可调）。见架构 5.3。 */
export interface SchedulingConfig {
  /** 全局并发（SW 唯一）。默认 3。 */
  maxConcurrent: number;
  /** 每秒请求数上限（令牌桶）。默认 2。 */
  rps: number;
  /** token/分钟上限，0 = 关闭额度保护。默认 0。 */
  tpmLimit: number;
  /** 单批最大重试次数。默认 5。 */
  maxRetries: number;
  /** 单批段数上限。默认 20。 */
  itemsPerBatch: number;
  /** 输入占 context window 比例。默认 0.7。 */
  batchTokenBudgetRatio: number;
}

/** 翻译模式。见架构 6.2 config.mode。 */
export type TranslateMode = 'basic' | 'agent';

/** 风格预设（智能体模式）。见架构 4.3 / 6.2 agent.stylePreset。 */
export type StylePreset = 'literary' | 'technical' | 'casual' | 'none';

/** 智能体模式配置。见架构 6.2 agent。 */
export interface AgentConfig {
  /** 用户自定义系统提示词，覆盖默认。 */
  systemPrompt: string;
  role: string;
  stylePreset: StylePreset;
  glossaryIds: string[];
  pageContextEnabled: boolean;
}

/** 缓存配置。见架构 6.1 / 6.2 cache。 */
export interface CacheConfig {
  enabled: boolean;
  maxSizeMB: number;
  ttlDays: number;
}

/** UI 偏好。见架构 6.2 ui。 */
export interface UIConfig {
  showOriginal: boolean;
  translationStyle: string;
  hoverOnly: boolean;
}

/** 完整配置根（storage.local `config` 键）。见架构 6.2。 */
export interface AppConfig {
  version: number;
  engines: Record<string, EngineConfig>;
  activeEngineId: string;
  targetLang: string;
  sourceLang: 'auto' | string;
  mode: TranslateMode;
  agent: AgentConfig;
  scheduling: SchedulingConfig;
  cache: CacheConfig;
  ui: UIConfig;
}

/**
 * 持久化队列中的批次状态（storage.local config.queue[batchId]）。
 * 供 chrome.alarms 恢复未完成批次，靠 batchId / item id 幂等续传。见架构 6.2 / 9。
 */
export interface BatchState {
  batchId: string;
  tabId: number;
  items: Item[];
  /** 已成功回填的 item id（跨重试 / 重连不重翻）。 */
  doneIds: string[];
  /** 失败的 item id。 */
  failedIds: string[];
  /** 已重试次数。 */
  attempts: number;
}

/**
 * 显示模式 —— 对应 storage.ui.showOriginal 的三态扩展（架构 6.2）。
 * - bilingual：原文 + 译文双显（默认）
 * - translation：仅译文（隐藏原文）
 * - original：仅原文（隐藏译文，等同未翻译视图）
 */
export type DisplayMode = 'bilingual' | 'translation' | 'original';

/**
 * 译文样式预设 —— 对应 storage.ui.translationStyle（架构 6.2）。
 * - normal：无特效
 * - blur：虚化（hover 显形）
 * - underline：下划线
 * - highlight：马克笔高亮
 */
export type TranslationStyle = 'normal' | 'blur' | 'underline' | 'highlight';

/**
 * 块级分类 —— DOM 提取器 block-classifier 产出，决定是否进入翻译队列。
 * 与 ParagraphCategory 等价（值集合略简：nav ≈ navigation），保留 PR-8 原命名。
 */
export type BlockCategory = 'content' | 'nav' | 'code' | 'skip';

/**
 * 占位符节点：一个内联标签的可重建结构。
 *
 * 嵌套内联（如 `<strong>...<em>...</em>...</strong>`）通过 children 中的
 * `{ ph: n }` 引用子占位符表达 —— 顶层 text 只出现最外层内联标签的 `[[n]]`，
 * 内层标签收纳在其父占位符的 children 里。
 */
export interface PlaceholderNode {
  /** 标签名（小写），如 'a' | 'strong' | 'code' */
  tag: string;
  /** 属性键值对（保留出现顺序），如 href / title，回填时逐条 setAttribute */
  attrs: Array<[string, string]>;
  /** 子内容：字符串为字面文本，{ ph } 为嵌套占位符引用 */
  children: Array<string | { ph: number }>;
}

/** inline-markup.serialize 产出的占位符。 */
export interface Placeholder {
  /** 占位符序号，对应 `[[n]]` 中的 n */
  index: number;
  /** 该内联节点的可重建结构 */
  node: PlaceholderNode;
}

/** serialize / restore 用的纯文本 + 占位符映射。 */
export interface SerializedInline {
  /** 含 `[[n]]` 占位符的纯文本，作为翻译协议输入发给 LLM */
  text: string;
  /** 占位符列表 */
  placeholders: Placeholder[];
}
