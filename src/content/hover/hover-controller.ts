/**
 * hover-controller —— 鼠标悬停段落翻译（架构第 8 节 P2 项 / TRA-27）。
 *
 * 区别于全页自动批量翻译（controller.ts）：hover 模式只翻译用户悬停的**单段**，
 * 轻量、按需、低 token。batch=1 走 orchestrator，优先命中 P0-6 缓存（近零延迟）。
 *
 * 职责：
 *  - 在 document 上监听 mouseover/mouseout/mousemove，命中可翻译段落（复用 P0-8 dom-walker
 *    的提取与分类判定）后，**防抖停留** dwellMs 才触发单段翻译。
 *  - 单段翻译路径：先查 content 侧缓存（P0-6 / cache-access.readCache），命中直接填浮层（近零延迟）；
 *    未命中经 Port 单发 TRANSLATE_BATCH（batch=1 由 packer 自然成批），orchestrator 命中缓存
 *    miss 强制调引擎，流式（P1-2）优先降延迟；RESULT/STREAM_CHUNK/ERROR 经 controller 回调回填浮层。
 *  - 译文浮层：悬停段旁浮层显示译文（bt-hover 前缀隔离），离开销毁；与 P1-3 操作条复用。
 *
 * 不破坏 P0-9 layout-guard 与 P1-3 交互层：hover 浮层是 body 子节点，不在原段落父容器内，
 * 不触发 layout-guard 重排守护；与全页渲染 wrapper 互不干扰（hover 模式下不启动全页渲染）。
 *
 * 纯逻辑 + DOM 监听，无直接 chrome 依赖（Port 由注入的 callbacks 桥接，便于 vitest 覆盖）。
 */
import type { DisplayMode, Item, TranslationStyle } from '../../shared/types';
import { translatePortName } from '../../shared/constants';
import {
  isError,
  isPortMessage,
  isResult,
  isStreamChunk,
} from '../../shared/messages';
import { classify } from '../extractor/block-classifier';
import { restore, serialize } from '../extractor/inline-markup';
import type { Placeholder } from '../../shared/types';
import { ParagraphRegistry } from '../paragraph-registry';
import { readCache, evictCache, writebackCache } from '../cache-access';
import { loadConfig } from '../../background/config/config-store';
import { updateControlBar } from '../floating-ui/mount';
import { mountHoverOverlay, type HoverOverlayHandle } from './hover-overlay';

/** hover 触发阈值默认值（架构约束「hover 防抖/触发阈值先在本 issue 讨论」）。
 *  - dwellMs：鼠标停留时长，默认 300ms（够过滤快速划过，又不太迟钝）。
 *  - minChars：段落最小字符数，默认 2（与 block-classifier 一致，过滤纯符号）。
 *  这些值可通过 HoverControllerOptions 注入覆盖（测试 / 未来 options 暴露）。 */
export const DEFAULT_HOVER_DWELL_MS = 300;
export const DEFAULT_HOVER_MIN_CHARS = 2;

/** hover-controller 对外依赖（Port 桥接 + 全页控制器复用），便于测试注入。 */
export interface HoverControllerDeps {
  /** 当前 tabId（用于构造 Port；全页 controller 同款握手）。 */
  getTabId: () => Promise<number | null>;
  /** 全页翻译是否开启（开启时 hover 不重复触发，避免双发）。 */
  isFullPageTranslating: () => boolean;
  /** Port 工厂注入（测试用 fake port；生产传 chrome.runtime.connect）。 */
  connectPort?: (name: string) => chrome.runtime.Port;
}

export interface HoverControllerOptions {
  /** 停留时长（ms），默认 DEFAULT_HOVER_DWELL_MS。 */
  dwellMs?: number;
  /** 段落最小字符数，默认 DEFAULT_HOVER_MIN_CHARS。 */
  minChars?: number;
  /** 定时器注入（测试用）。 */
  scheduler?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** 依赖注入。 */
  deps: HoverControllerDeps;
}

/** hover 状态机：当前悬停的段落 id 与浮层。 */
interface HoverState {
  /** 鼠标当前所在的可翻译段落 id。 */
  hoveredId: string;
  /** 段落 DOM 节点。 */
  node: HTMLElement;
  /** 原文。 */
  sourceText: string;
  /** 占位符（懒序列化）。 */
  placeholders: Placeholder[];
  /** 浮层句柄。 */
  overlay: HoverOverlayHandle;
  /** dwell 定时器句柄。 */
  dwellTimer: ReturnType<typeof setTimeout> | null;
  /** 该段是否已触发翻译（避免重复下发）。 */
  triggered: boolean;
}

/**
 * HoverController —— content script 单例。
 *
 * 用法：content 入口在 hoverOnly 模式下创建并 attach；离开页面 / 切回全页模式时 detach。
 */
export class HoverController {
  private readonly dwellMs: number;
  private readonly minChars: number;
  private readonly scheduler: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly deps: HoverControllerDeps;

  /** 段落登记（hover 命中时按需登记，避免全页提取的开销）。 */
  private readonly registry = new ParagraphRegistry();
  /** 当前 hover 状态（null = 未悬停可翻译段）。 */
  private state: HoverState | null = null;
  /** 已 attach 的 document 监听器（detach 时移除）。 */
  private listeners: Array<{ type: string; fn: (e: Event) => void }> = [];
  private scrollFn: (() => void) | null = null;
  private attached = false;

  /** hover 专用 Port（懒建：首次触发翻译才连；断开时清空，下次重连）。 */
  private port: chrome.runtime.Port | null = null;
  /** Port 名（translate:<tabId>，与全页同款通道，SW 侧 orchestrator 通用处理）。 */
  private portName: string | null = null;

  /** 当前显示模式 + 样式（启动时从配置读，供浮层使用）。 */
  private displayMode: DisplayMode = 'bilingual';
  private translationStyle: TranslationStyle = 'normal';

  constructor(opts: HoverControllerOptions) {
    this.dwellMs = opts.dwellMs ?? DEFAULT_HOVER_DWELL_MS;
    this.minChars = opts.minChars ?? DEFAULT_HOVER_MIN_CHARS;
    this.scheduler = opts.scheduler ?? setTimeout;
    this.deps = opts.deps;
  }

  /** 启动：拉配置 + 挂 document 监听。幂等。 */
  async start(): Promise<void> {
    if (this.attached) return;
    try {
      const cfg = await loadConfig();
      this.displayMode = cfg.ui.displayMode;
      this.translationStyle = (cfg.ui.translationStyle as TranslationStyle) ?? 'normal';
    } catch {
      /* 配置缺失走默认值 */
    }
    this.attachListeners();
    this.attached = true;
  }

  /** 停止：移除监听 + 销毁当前浮层 + 断开 Port。幂等。 */
  stop(): void {
    if (!this.attached) return;
    this.detachListeners();
    this.destroyCurrent();
    this.disconnectPort();
    this.registry.clear();
    this.attached = false;
  }

  /** 当前是否正悬停某段。 */
  isHovering(): boolean {
    return this.state !== null;
  }

  // ── 监听挂载 ────────────────────────────────────────────────────────────

  private attachListeners(): void {
    const onOver = (e: Event): void => this.handleMouseOver(e as MouseEvent);
    const onOut = (e: Event): void => this.handleMouseOut(e as MouseEvent);
    const onMove = (e: Event): void => this.handleMouseMove(e as MouseEvent);
    document.addEventListener('mouseover', onOver, true);
    document.addEventListener('mouseout', onOut, true);
    document.addEventListener('mousemove', onMove, true);
    this.listeners.push(
      { type: 'mouseover', fn: onOver },
      { type: 'mouseout', fn: onOut },
      { type: 'mousemove', fn: onMove },
    );
    // 滚动时重定位浮层（fixed 定位需跟随段落）。
    const onScroll = (): void => this.state?.overlay.reposition();
    window.addEventListener('scroll', onScroll, true);
    this.scrollFn = onScroll;
  }

  private detachListeners(): void {
    for (const { type, fn } of this.listeners) {
      document.removeEventListener(type, fn, true);
    }
    this.listeners = [];
    if (this.scrollFn) {
      window.removeEventListener('scroll', this.scrollFn, true);
      this.scrollFn = null;
    }
  }

  // ── 事件处理 ────────────────────────────────────────────────────────────

  /**
   * mouseover（捕获）：从事件目标上溯找最近的可翻译块级元素。
   * 命中且与当前不同 → 切换 hover 目标，启动 dwell 计时。
   */
  private handleMouseOver(e: MouseEvent): void {
    const target = e.target as Element | null;
    if (!target || target.nodeType !== 1) return;
    // 忽略扩展自身 UI（控制条 / 浮层 / shadow 宿主）。
    if (isOwnUI(target)) return;
    const block = findTranslatableBlock(target, this.minChars);
    if (!block) {
      // 离开可译段到非可译区：销毁当前浮层。
      if (this.state) this.destroyCurrent();
      return;
    }
    const id = block.id;
    if (this.state && this.state.hoveredId === id) return; // 同段，不动
    // 切到新段：销毁旧浮层，建新状态。
    this.destroyCurrent();
    this.beginHover(id, block.node, block.text, block.placeholders);
  }

  /** mouseout：若离开当前段（relatedTarget 不在段内）则销毁浮层。 */
  private handleMouseOut(e: MouseEvent): void {
    if (!this.state) return;
    const related = e.relatedTarget as Element | null;
    if (related && this.state.node.contains(related)) return; // 仍在段内（子元素间移动）
    // 离开段：销毁浮层（dwell 未触发也一并清掉计时器）。
    this.destroyCurrent();
  }

  /** mousemove：停留在同段时持续重定位浮层（段落高度变化 / 滚动微动）。 */
  private handleMouseMove(e: MouseEvent): void {
    if (!this.state) return;
    // 仅当浮层已存在时重定位（dwell 未到、浮层未建则跳过）。
    this.state.overlay.reposition();
    void e;
  }

  // ── hover 状态机 ─────────────────────────────────────────────────────────

  /** 开始悬停某段：建浮层（loading 态）+ 启动 dwell 计时。 */
  private beginHover(
    id: string,
    node: HTMLElement,
    sourceText: string,
    placeholders: Placeholder[],
  ): void {
    // 登记到 registry（retranslate / edit 回调用）。
    this.registry.register({ id, node, text: sourceText });
    const overlay = mountHoverOverlay(
      { id, text: sourceText, node },
      {
        displayMode: this.displayMode,
        style: this.translationStyle,
        restoreMarkup: (text) => this.restoreMarkup(placeholders, text),
        actions: {
          retranslate: () => { void this.retranslateParagraph(id); },
          edit: (t: string) => { void this.onEditTranslation(id, t); },
          copy: () => this.onCopyTranslation(id),
        },
      },
    );
    overlay.markLoading();

    // 先置 state（dwellTimer 占位），再起计时器；同步 scheduler 场景下计时器回调
    // 立即执行，需保证回调进入时 this.state 已就绪（否则早退守卫会跳过翻译）。
    this.state = {
      hoveredId: id,
      node,
      sourceText,
      placeholders,
      overlay,
      dwellTimer: null,
      triggered: false,
    };
    this.state.dwellTimer = this.scheduler(() => {
      void this.triggerTranslation(id, sourceText);
    }, this.dwellMs);
  }

  /** 销毁当前 hover 状态（浮层 + 计时器）。 */
  private destroyCurrent(): void {
    if (!this.state) return;
    if (this.state.dwellTimer) clearTimeout(this.state.dwellTimer);
    this.state.overlay.remove();
    this.state = null;
  }

  // ── 翻译触发 ────────────────────────────────────────────────────────────

  /** dwell 到期：先查缓存，命中直接填浮层；未命中经 Port 单发。 */
  private async triggerTranslation(id: string, sourceText: string): Promise<void> {
    if (!this.state || this.state.hoveredId !== id) return; // 已切走
    if (this.state.triggered) return; // 已下发
    this.state.triggered = true;

    // 全页翻译进行中 → 跳过（避免双发；全页会覆盖该段）。
    if (this.deps.isFullPageTranslating()) return;

    // 1. 缓存命中：近零延迟填浮层（验收项）。
    try {
      const cfg = await loadConfig();
      const hit = await readCache(sourceText, cfg);
      if (hit && this.state?.hoveredId === id) {
        this.state.overlay.setText(hit.translated);
        return;
      }
    } catch {
      /* 缓存读失败 → 走 Port */
    }

    // 2. 未命中：经 Port 单发 TRANSLATE_BATCH（batch=1 由 packer 自然成批）。
    const port = await this.ensurePort();
    if (!port) {
      this.state?.overlay.markError('翻译通道未就绪');
      return;
    }
    if (!this.state || this.state.hoveredId !== id) return; // 已切走
    const item: Item = { id, text: sourceText };
    try {
      port.postMessage({ type: 'TRANSLATE_BATCH', items: [item] });
    } catch {
      this.disconnectPort();
      this.state?.overlay.markError('翻译通道已断开');
    }
  }

  // ── Port 生命周期 ────────────────────────────────────────────────────────

  /**
   * 懒建翻译 Port（translate:<tabId>），挂 onMessage 路由到浮层回填。
   * 首次触发翻译才连；断开后下次重连。Port 与全页通道同名 —— SW 侧 port-server /
   * orchestrator 通用处理 TRANSLATE_BATCH，batch=1 由 packer 自然成批，缓存 miss 调引擎，
   * 流式（P1-2）优先降延迟（架构 2.2 / 4.5）。
   */
  private async ensurePort(): Promise<chrome.runtime.Port | null> {
    if (this.port) return this.port;
    const tabId = await this.deps.getTabId();
    if (tabId == null) return null;
    const name = translatePortName(tabId);
    this.portName = name;
    const connect = this.deps.connectPort ?? ((n: string) => chrome.runtime.connect({ name: n }));
    try {
      const port = connect(name);
      port.onMessage.addListener((m: unknown) => this.onPortMessage(m));
      port.onDisconnect.addListener(() => {
        this.port = null;
        this.portName = null;
      });
      this.port = port;
      return port;
    } catch {
      return null;
    }
  }

  /** 断开 Port（停止 / 通道错误时）。 */
  private disconnectPort(): void {
    if (!this.port) return;
    try {
      this.port.disconnect();
    } catch {
      /* 已断 */
    }
    this.port = null;
    this.portName = null;
  }

  /** Port 消息路由：RESULT/STREAM_CHUNK/ERROR → 浮层回填。 */
  private onPortMessage(m: unknown): void {
    if (!isPortMessage(m)) return;
    if (isResult(m)) this.applyResult(m.id, m.translated);
    else if (isStreamChunk(m)) this.applyStreamChunk(m.id, m.chunk);
    else if (isError(m)) this.applyError(m.id, m.reason);
  }

  // ── Port 消息回填（由 controller 的 onPortMessage 转发） ─────────────────

  /** RESULT 回填：整段覆盖浮层。 */
  applyResult(id: string, translated: string): void {
    if (this.state?.hoveredId === id) this.state.overlay.setText(translated);
  }

  /** STREAM_CHUNK 增量：累加到浮层文本。 */
  applyStreamChunk(id: string, chunk: string): void {
    if (!this.state || this.state.hoveredId !== id) return;
    // hover 浮层用整段累加（低频单段，无需节流）。
    const cur = this.state.overlay.getText();
    this.state.overlay.setText(cur + chunk);
  }

  /** ERROR 回填：原位错误占位。 */
  applyError(id: string, reason: string): void {
    if (this.state?.hoveredId === id) this.state.overlay.markError(reason);
  }

  // ── P1-3 操作条复用 ──────────────────────────────────────────────────────

  /** 手动重译单段：逐出缓存 → Port 单发。 */
  async retranslateParagraph(id: string): Promise<void> {
    const entry = this.registry.get(id);
    if (!entry) return;
    if (this.deps.isFullPageTranslating()) {
      updateControlBar({ error: '全页翻译进行中，请先关闭' });
      return;
    }
    const port = await this.ensurePort();
    if (!port) {
      updateControlBar({ error: '翻译通道未就绪' });
      return;
    }
    try {
      const cfg = await loadConfig();
      await evictCache(entry.sourceText, cfg);
    } catch {
      /* 逐出失败不阻塞 */
    }
    this.state?.overlay.clearError();
    if (this.state?.hoveredId === id) this.state.overlay.markLoading();
    if (this.state && this.state.hoveredId === id) this.state.triggered = true;
    try {
      port.postMessage({ type: 'TRANSLATE_BATCH', items: [{ id, text: entry.sourceText }] });
    } catch {
      this.disconnectPort();
      this.state?.overlay.markError('翻译通道已断开');
    }
  }

  /** 编辑译文回写缓存（与 controller 同款契约）。 */
  async onEditTranslation(id: string, newText: string): Promise<void> {
    const entry = this.registry.get(id);
    if (this.state?.hoveredId === id) this.state.overlay.setText(newText);
    if (!entry) return;
    try {
      const cfg = await loadConfig();
      await writebackCache(entry.sourceText, newText, cfg);
    } catch {
      /* 回写失败不影响本地显示 */
    }
  }

  /** 复制译文。 */
  onCopyTranslation(id: string): void {
    if (!this.state || this.state.hoveredId !== id) return;
    const text = this.state.overlay.getText();
    try {
      void navigator.clipboard?.writeText(text);
    } catch {
      /* 静默 */
    }
  }

  // ── 辅助 ────────────────────────────────────────────────────────────────

  /** 占位符还原：有则 restore，无则纯文本。 */
  private restoreMarkup(placeholders: Placeholder[], text: string): Node[] {
    if (placeholders && placeholders.length > 0) return [restore(text, placeholders, document)];
    return [document.createTextNode(text)];
  }
}

// ── 纯函数：段落命中判定（便于单测） ───────────────────────────────────────

/** 命中结果。 */
export interface HoverHit {
  id: string;
  node: HTMLElement;
  text: string;
  placeholders: Placeholder[];
}

/**
 * 从事件目标上溯找最近的可翻译块级元素（复用 P0-8 dom-walker 的提取与分类判定）。
 *
 * 流程：从 target 起，逐级 closest(BLOCK_SELECTOR 候选) → 对每个候选用 dom-walker 的
 * 序列化 + classify 判定是否可译（content/nav 按配置、code/skip 排除）→ 命中即返回。
 * 复用 dom-walker.hashId 生成稳定 id（与全页模式同款 id，缓存 key 一致，跨模式命中缓存）。
 */
export function findTranslatableBlock(target: Element, minChars: number): HoverHit | null {
  // 候选块级选择器（与 dom-walker BLOCK_SELECTOR 一致）。
  const BLOCK_SELECTOR =
    'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, dd, dt, figcaption, caption, summary, div, address';
  let el: Element | null = target.closest(BLOCK_SELECTOR);
  while (el) {
    // 跳过扩展自身 UI。
    if (isOwnUI(el)) { el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null; continue; }
    // 跳过不可译标签（与 dom-walker SKIP_TAGS 一致）。
    if (el.closest('script, style, noscript, code, pre, template, svg, math, iframe, canvas, object, embed, video, audio, map, area')) {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      continue;
    }
    if (el.closest('input, textarea, select, button, option, optgroup, fieldset, [contenteditable]')) {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      continue;
    }
    if (el.closest('[data-bt-hover], [data-bt-translation], [data-bt-skip]')) {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      continue;
    }
    const { text, placeholders } = serialize(el);
    if (!text.trim() || text.trim().length < minChars) {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      continue;
    }
    const category = classify(el, { translateNav: false, minChars });
    if (category === 'code' || category === 'skip') {
      el = el.parentElement?.closest(BLOCK_SELECTOR) ?? null;
      continue;
    }
    // 用 dom-walker 的 hashId 生成稳定 id（与全页模式同款，缓存跨模式命中）。
    // hashId 需要 order，hover 单段无全页顺序；用文本哈希的简化版（与全页同段同 id
    // 要求顺序一致 —— 全页提取时该段也有一个 order，hover 无法预知。
    // 故改用纯文本哈希作 id，并在 registry 登记；缓存 key 由原文+引擎+指纹决定，
    // 与 id 无关，跨模式缓存命中不受影响）。
    const id = hoverId(text);
    return { id, node: el as HTMLElement, text, placeholders };
  }
  return null;
}

/** hover 段落稳定 id：纯文本哈希（不依赖全页顺序）。 */
export function hoverId(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.codePointAt(i)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'bt_h_' + (h >>> 0).toString(36);
}

/** 是否为扩展自身 UI（控制条宿主 / 浮层 / shadow 宿主），命中则忽略。 */
export function isOwnUI(el: Element): boolean {
  return !!el.closest?.(
    '#bt-control-host, #bt-hover-style-host, [data-bt-hover], .bt-translation, [data-bt-translation]',
  );
}

/** 仅供测试：取当前 hover 状态快照（id 或 null）。 */
export function _currentHoverIdForTests(ctrl: HoverController): string | null {
  return ctrl['state']?.hoveredId ?? null;
}
