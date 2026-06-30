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
/** 译文文本容器类（toolbar / 编辑态与之分离，互不覆盖）。 */
const TEXT_CLASS = `${BASE_CLASS}__text`;
/** 悬停操作条类。 */
const TOOLBAR_CLASS = `${BASE_CLASS}__toolbar`;
/** 编辑态容器类。 */
const EDIT_CLASS = `${BASE_CLASS}__edit`;
/** 操作条按钮类。 */
const TOOLBAR_BTN_CLASS = `${BASE_CLASS}__btn`;

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
  position: relative;
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
.${BASE_CLASS}--underline .${TEXT_CLASS} { text-decoration: inherit; }
.${BASE_CLASS}--highlight .${TEXT_CLASS} { background: linear-gradient(transparent 55%, rgba(255,243,160,.85) 55%); }
.${ERROR_CLASS} .${TEXT_CLASS} { color: #b00020; font-style: italic; opacity: .85; }
.${ERROR_CLASS} .${TEXT_CLASS}::before { content: "\\26a0  "; }
[${ORIGINAL_HIDDEN_ATTR}="hidden"] { display: none !important; }
.${TOOLBAR_CLASS} {
  display: none;
  position: absolute;
  top: -22px;
  right: 0;
  gap: 4px;
  padding: 2px;
  border-radius: 6px;
  background: #1f2328;
  box-shadow: 0 2px 8px rgba(0,0,0,.2);
  z-index: 1;
}
.${BASE_CLASS}:hover .${TOOLBAR_CLASS} { display: inline-flex; }
.${TOOLBAR_BTN_CLASS} {
  border: none;
  background: transparent;
  color: #fff;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
.${TOOLBAR_BTN_CLASS}:hover { background: rgba(255,255,255,.18); }
.${EDIT_CLASS} { display: flex; flex-direction: column; gap: 4px; margin-top: 2px; }
.${EDIT_CLASS} textarea {
  width: 100%;
  min-height: 48px;
  box-sizing: border-box;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 4px 6px;
  font: inherit;
  font-size: inherit;
  line-height: inherit;
  resize: vertical;
}
.${EDIT_CLASS}__actions { display: flex; gap: 6px; }
.${EDIT_CLASS}__actions .${TOOLBAR_BTN_CLASS} { position: static; background: #2563eb; }
.${EDIT_CLASS}__actions .${TOOLBAR_BTN_CLASS}.cancel { background: #6b7280; }
`;

/** 内联标记还原钩子（P0-8 inline-markup 注入）：把含 `[[n]]` 占位符的译文还原成 DOM 节点。 */
export type MarkupRestorer = (translated: string) => Node[];

/** 悬停操作条回调（P1-3）：renderer 只触发，业务（回写缓存 / 重译 / 复制）由 controller 实现。 */
export interface RenderActions {
  /** 重译当前段。 */
  retranslate: () => void;
  /** 编辑保存：用户点击「保存」时带回新译文文本。 */
  edit: (newText: string) => void;
  /** 复制当前译文。 */
  copy: () => void;
}

export interface RenderOptions {
  /** 显示模式，默认 bilingual。 */
  displayMode?: DisplayMode;
  /** 译文样式预设，默认 normal。 */
  style?: TranslationStyle;
  /** inline-markup 还原钩子；未提供则降级纯文本。 */
  restoreMarkup?: MarkupRestorer;
  /** 悬停操作条回调；未提供则不渲染操作条（P0 行为）。 */
  actions?: RenderActions;
}

/** 渲染句柄：持有 wrapper 引用，支持后续切换 / 流式 / 错误 / 编辑 / 移除。 */
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
  /** 当前译文文本（含占位符的原始串，供复制 / 编辑预填）。 */
  getText(): string;
  /** 进入编辑态：用 textarea 替换译文，保存/取消回调见 RenderOptions.actions.edit。 */
  enterEdit(): void;
  /** 退出编辑态（取消），恢复显示当前译文。 */
  exitEdit(): void;
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

/** 用还原器（或默认）填充文本容器内容。 */
function fillContent(textContainer: HTMLElement, text: string, restorer: MarkupRestorer): void {
  textContainer.replaceChildren(...restorer(text));
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
 * wrapper 内部结构（P1-3）：文本容器 `.bt-translation__text` + 悬停操作条 `.bt-translation__toolbar`。
 * 文本与操作条分离，使 setText / appendChunk / markError 只改文本容器，不会清掉操作条。
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
  const actions = options.actions;

  const wrapper = document.createElement('div');
  wrapper.className = BASE_CLASS;
  wrapper.dataset.btId = paragraph.id;
  wrapper.setAttribute('data-bt-translation', '');

  const textContainer = document.createElement('span');
  textContainer.className = TEXT_CLASS;
  fillContent(textContainer, translated, restorer);
  wrapper.appendChild(textContainer);

  // 操作条（仅当提供 actions 时渲染，P0 调用无 actions → 无操作条，行为不变）。
  // 编辑按钮需触发 handle.enterEdit（handle 在下方构造），故先建 toolbar 占位，构造后回填。
  const toolbar = actions ? buildToolbar(actions) : null;
  if (toolbar) wrapper.appendChild(toolbar);

  applyStyle(wrapper, style);

  const target = resolveInsertionPoint(paragraph.node!);
  applyDisplayMode(wrapper, paragraph.node!, displayMode);

  // 插入 DOM —— 此处绝不触碰 paragraph.node 的属性 / 类 / style。
  insertWrapper(target, wrapper);

  let buffer = translated;
  let errored = false;

  /** 退出编辑态：移除编辑容器，恢复文本容器显示。 */
  const restoreFromEdit = (): void => {
    const edit = wrapper.querySelector(`.${EDIT_CLASS}`);
    edit?.remove();
    textContainer.classList.remove(HIDDEN_CLASS);
  };

  const handle: RenderHandle = {
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
      if (!errored) fillContent(textContainer, buffer, restorer);
    },
    setText(next) {
      buffer = next;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      // 若处于编辑态，先退出再刷新文本。
      restoreFromEdit();
      fillContent(textContainer, next, restorer);
    },
    getText() {
      return buffer;
    },
    enterEdit() {
      // 已在编辑态则先清掉旧编辑容器。
      wrapper.querySelector(`.${EDIT_CLASS}`)?.remove();
      const edit = document.createElement('div');
      edit.className = EDIT_CLASS;
      const textarea = document.createElement('textarea');
      textarea.value = buffer;
      textarea.rows = 2;
      const actionsRow = document.createElement('div');
      actionsRow.className = `${EDIT_CLASS}__actions`;
      const save = document.createElement('button');
      save.type = 'button';
      save.className = TOOLBAR_BTN_CLASS;
      save.textContent = '保存';
      save.addEventListener('click', () => {
        const v = textarea.value;
        actions?.edit(v);
        // controller 的 edit 回调会调 setText 更新显示；此处统一退出编辑态。
        restoreFromEdit();
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = `${TOOLBAR_BTN_CLASS} cancel`;
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => restoreFromEdit());
      actionsRow.append(save, cancel);
      edit.append(textarea, actionsRow);
      // 隐藏文本容器，编辑容器接管显示。
      textContainer.classList.add(HIDDEN_CLASS);
      wrapper.appendChild(edit);
      textarea.focus();
    },
    exitEdit() {
      restoreFromEdit();
    },
    markError(reason) {
      errored = true;
      // 退出可能存在的编辑态，确保错误占位可见。
      restoreFromEdit();
      wrapper.classList.add(ERROR_CLASS);
      textContainer.replaceChildren(document.createTextNode(errorLabel(reason)));
    },
    clearError() {
      if (!errored) return;
      errored = false;
      wrapper.classList.remove(ERROR_CLASS);
      fillContent(textContainer, buffer, restorer);
    },
    remove() {
      wrapper.remove();
    },
  };

  // 编辑按钮：触发 handle.enterEdit（handle 已构造，安全回填）。
  if (toolbar) {
    const editBtn = toolbar.querySelector<HTMLButtonElement>(`[data-bt-action="edit"]`);
    editBtn?.addEventListener('click', () => handle.enterEdit());
  }

  return handle;
}

/** 构造悬停操作条（重译 / 编辑 / 复制）。编辑按钮以 data-bt-action="edit" 标记，由 render 回填点击。 */
function buildToolbar(actions: RenderActions): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = TOOLBAR_CLASS;
  const retranslate = document.createElement('button');
  retranslate.type = 'button';
  retranslate.className = TOOLBAR_BTN_CLASS;
  retranslate.textContent = '重译';
  retranslate.title = '手动重译（跳过缓存）';
  retranslate.addEventListener('click', () => actions.retranslate());
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = TOOLBAR_BTN_CLASS;
  edit.textContent = '编辑';
  edit.title = '编辑译文并回写缓存';
  edit.dataset.btAction = 'edit';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = TOOLBAR_BTN_CLASS;
  copy.textContent = '复制';
  copy.title = '复制译文';
  copy.addEventListener('click', () => actions.copy());
  toolbar.append(retranslate, edit, copy);
  return toolbar;
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
