/**
 * 译文浮层（hover 模式专用）—— src/content/hover/hover-overlay.ts
 *
 * 区别于全页双语渲染器（在原段落后插入常驻 wrapper），hover 浮层是**临时**的：
 * 悬停命中可翻译段落时，在该段落附近弹出译文浮层；鼠标离开段落（与浮层）后销毁。
 *
 * 契约（架构第 3、6、9 节）：
 * - CSS 一律 `bt-hover` 前缀，Shadow DOM 隔离，零页面样式污染。
 * - 绝不改动原段落节点任何属性 / 类 / style（只读，与渲染器一致）。
 * - 浮层定位用 `position: fixed` + 原段落 getBoundingClientRect，滚动时由 controller 重算。
 * - 与 P1-3 操作条复用：浮层内挂「重译 / 编辑 / 复制」按钮（编辑回写缓存走 controller 既有路径）。
 * - 不依赖 layout-guard：浮层是 body 子节点，不在原段落父容器内，不受页面重排影响。
 *
 * 纯 DOM 操作，无 chrome 依赖；vitest + jsdom 可直接覆盖生命周期与定位。
 */
import type { DisplayMode, Paragraph, TranslationStyle } from '../../shared/types';
import type { RenderActions } from '../renderer/bilingual-renderer';

/** Shadow DOM 样式（bt-hover 前缀隔离）。 */
const OVERLAY_STYLES = `
:host { all: initial; }
.bt-hover {
  position: fixed;
  z-index: 2147483646;
  max-width: 420px;
  min-width: 120px;
  padding: 8px 10px;
  border-radius: 8px;
  background: #ffffff;
  color: #1f2328;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 14px;
  line-height: 1.5;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(0, 0, 0, 0.1);
  word-break: break-word;
}
.bt-hover__text { display: block; }
.bt-hover__text--blur { filter: blur(3px); transition: filter .2s ease; cursor: pointer; }
.bt-hover__text--blur:hover { filter: none; }
.bt-hover__text--underline { text-decoration: underline; text-underline-offset: 2px; text-decoration-color: rgba(0,0,0,.35); }
.bt-hover__text--highlight { background: linear-gradient(transparent 55%, rgba(255,243,160,.85) 55%); }
.bt-hover__error { color: #b00020; font-style: italic; }
.bt-hover__error::before { content: "\\26a0  "; }
.bt-hover__loading { color: #6b7280; font-style: italic; }
.bt-hover__toolbar {
  display: flex;
  gap: 4px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(0,0,0,.08);
}
.bt-hover__btn {
  border: none;
  background: #2563eb;
  color: #fff;
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-family: inherit;
}
.bt-hover__btn:hover { background: #1d4ed8; }
.bt-hover__btn.cancel { background: #6b7280; }
.bt-hover__btn.cancel:hover { background: #4b5563; }
.bt-hover__edit { display: flex; flex-direction: column; gap: 4px; }
.bt-hover__edit textarea {
  width: 100%;
  min-width: 240px;
  min-height: 48px;
  box-sizing: border-box;
  border: 1px solid #d0d7de;
  border-radius: 6px;
  padding: 4px 6px;
  font: inherit;
  font-size: 13px;
  line-height: 1.4;
  resize: vertical;
}
.bt-hover__edit-actions { display: flex; gap: 6px; }
`;

/** 运行时样式表宿主 id（整页唯一）。 */
const HOST_ID = 'bt-hover-style-host';

/** 确保样式宿主只注入一次（一个隐藏 div 挂 Shadow DOM，仅装样式，避免重复 style 标签）。 */
let styleHost: HTMLDivElement | null = null;
function ensureStyleHost(doc: Document): void {
  if (styleHost && styleHost.isConnected) return;
  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.style.display = 'none';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = doc.createElement('style');
  style.textContent = OVERLAY_STYLES;
  shadow.appendChild(style);
  (doc.body ?? doc.documentElement).appendChild(host);
  styleHost = host;
}

/** 样式预设 → text 容器修饰类。 */
const STYLE_TEXT_CLASS: Record<TranslationStyle, string> = {
  normal: '',
  blur: 'bt-hover__text--blur',
  underline: 'bt-hover__text--underline',
  highlight: 'bt-hover__text--highlight',
};

/** HoverOverlay 句柄：持有浮层 DOM，支持 setText / markError / clearError / 重定位 / 移除。 */
export interface HoverOverlayHandle {
  readonly id: string;
  /** 浮层根（已插入 body）。 */
  readonly overlay: HTMLDivElement;
  /** 切换显示模式（hover 模式只支持 bilingual / translation；original 隐藏浮层）。 */
  setDisplayMode(mode: DisplayMode): void;
  /** 替换整段译文（RESULT / 缓存命中回填）。 */
  setText(translated: string): void;
  /** 显示加载中占位。 */
  markLoading(): void;
  /** 标记失败，显示错误占位。 */
  markError(reason: string): void;
  /** 清除错误占位，恢复当前译文。 */
  clearError(): void;
  /** 按原段落最新 rect 重定位浮层。 */
  reposition(): void;
  /** 当前译文文本（编辑预填 / 复制用）。 */
  getText(): string;
  /** 进入编辑态。 */
  enterEdit(): void;
  /** 退出编辑态。 */
  exitEdit(): void;
  /** 移除浮层（销毁）。 */
  remove(): void;
}

/** 文本 → DOM 节点（占位符还原由 controller 通过 restorer 注入；这里持有闭包）。 */
export interface HoverOverlayOptions {
  displayMode?: DisplayMode;
  style?: TranslationStyle;
  /** 译文还原钩子（默认纯文本）。 */
  restoreMarkup?: (text: string) => Node[];
  /** P1-3 操作条回调；不提供则无操作条。 */
  actions?: RenderActions;
}

/** 创建并挂载一个 hover 浮层。返回句柄。 */
export function mountHoverOverlay(
  paragraph: Paragraph,
  options: HoverOverlayOptions = {},
): HoverOverlayHandle {
  ensureStyleHost(document);
  const displayMode = options.displayMode ?? 'bilingual';
  const style = options.style ?? 'normal';
  const restorer = options.restoreMarkup ?? ((t: string) => [document.createTextNode(t)]);
  const actions = options.actions;

  const overlay = document.createElement('div');
  overlay.className = 'bt-hover';
  overlay.dataset.btId = paragraph.id;
  overlay.setAttribute('data-bt-hover', '');

  const textContainer = document.createElement('span');
  textContainer.className = 'bt-hover__text';
  const textCls = STYLE_TEXT_CLASS[style];
  if (textCls) textContainer.classList.add(textCls);
  overlay.appendChild(textContainer);

  const toolbar = actions ? buildToolbar(actions) : null;
  if (toolbar) overlay.appendChild(toolbar);

  document.body.appendChild(overlay);

  let buffer = '';
  let errored = false;

  const fillText = (text: string): void => {
    textContainer.replaceChildren(...restorer(text));
  };

  const restoreFromEdit = (): void => {
    const edit = overlay.querySelector('.bt-hover__edit');
    edit?.remove();
    textContainer.classList.remove('bt-hover__text--hidden');
  };

  const handle: HoverOverlayHandle = {
    id: paragraph.id,
    overlay,
    setDisplayMode(mode) {
      // original：隐藏整个浮层（仅看原文）；其余显示。
      overlay.style.display = mode === 'original' ? 'none' : '';
    },
    setText(next) {
      buffer = next;
      errored = false;
      overlay.classList.remove('bt-hover__error');
      textContainer.classList.remove('bt-hover__loading');
      restoreFromEdit();
      fillText(next);
    },
    markLoading() {
      errored = false;
      textContainer.replaceChildren(document.createTextNode('翻译中…'));
      textContainer.classList.add('bt-hover__loading');
    },
    markError(reason) {
      errored = true;
      textContainer.classList.remove('bt-hover__loading');
      restoreFromEdit();
      overlay.classList.add('bt-hover__error');
      textContainer.replaceChildren(document.createTextNode(`翻译失败：${reason}`));
    },
    clearError() {
      if (!errored) return;
      errored = false;
      overlay.classList.remove('bt-hover__error');
      fillText(buffer);
    },
    getText() {
      return buffer;
    },
    reposition() {
      const rect = (paragraph.node ?? paragraph.element)?.getBoundingClientRect();
      if (!rect) return;
      // 浮层放在段落正下方，左对齐；超出视口右侧时右对齐，超出底部时上移到段落上方。
      const margin = 6;
      let left = rect.left;
      let top = rect.bottom + margin;
      const ow = overlay.offsetWidth;
      const oh = overlay.offsetHeight;
      if (left + ow > window.innerWidth) left = Math.max(0, window.innerWidth - ow - margin);
      if (top + oh > window.innerHeight) {
        const above = rect.top - oh - margin;
        if (above >= 0) top = above;
      }
      overlay.style.left = `${Math.max(0, left)}px`;
      overlay.style.top = `${Math.max(0, top)}px`;
    },
    enterEdit() {
      overlay.querySelector('.bt-hover__edit')?.remove();
      const edit = document.createElement('div');
      edit.className = 'bt-hover__edit';
      const textarea = document.createElement('textarea');
      textarea.value = buffer;
      textarea.rows = 2;
      const actionsRow = document.createElement('div');
      actionsRow.className = 'bt-hover__edit-actions';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'bt-hover__btn';
      save.textContent = '保存';
      save.addEventListener('click', () => {
        const v = textarea.value;
        actions?.edit(v);
        restoreFromEdit();
      });
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'bt-hover__btn cancel';
      cancel.textContent = '取消';
      cancel.addEventListener('click', () => restoreFromEdit());
      actionsRow.append(save, cancel);
      edit.append(textarea, actionsRow);
      textContainer.classList.add('bt-hover__text--hidden');
      overlay.appendChild(edit);
      textarea.focus();
    },
    exitEdit() {
      restoreFromEdit();
    },
    remove() {
      overlay.remove();
    },
  };

  // 编辑按钮（与渲染器一致：data-bt-action="edit" 由 handle.enterEdit 接管）。
  if (toolbar) {
    const editBtn = toolbar.querySelector<HTMLButtonElement>('[data-bt-action="edit"]');
    editBtn?.addEventListener('click', () => handle.enterEdit());
  }

  handle.reposition();
  if (displayMode === 'original') overlay.style.display = 'none';

  return handle;
}

/** 构造操作条（重译 / 编辑 / 复制）。编辑按钮 data-bt-action="edit" 由 mountHoverOverlay 回填。 */
function buildToolbar(actions: RenderActions): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'bt-hover__toolbar';
  const retranslate = document.createElement('button');
  retranslate.type = 'button';
  retranslate.className = 'bt-hover__btn';
  retranslate.textContent = '重译';
  retranslate.title = '手动重译（跳过缓存）';
  retranslate.addEventListener('click', () => actions.retranslate());
  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'bt-hover__btn';
  edit.textContent = '编辑';
  edit.title = '编辑译文并回写缓存';
  edit.dataset.btAction = 'edit';
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'bt-hover__btn';
  copy.textContent = '复制';
  copy.title = '复制译文';
  copy.addEventListener('click', () => actions.copy());
  toolbar.append(retranslate, edit, copy);
  return toolbar;
}
