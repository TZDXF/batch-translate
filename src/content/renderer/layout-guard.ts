/**
 * layout-guard —— 防排版破坏（架构第 3、9 节）。
 *
 * 三件事：
 * 1. 容器感知插入：表格 / flex / grid 下，译文插到不破结构的位置（cell 内 / 原节点内部）。
 * 2. MutationObserver 防重排：页面 JS 删除 / 移动译文 wrapper 时按原位重新插入。
 * 3. ResizeObserver 防撑破：译文宽度超出容器时收敛（环境无实现时降级跳过，不影响功能）。
 *
 * 纯函数 resolveInsertionPoint / insertWrapper / isAtTarget 同时供 bilingual-renderer 使用，
 * 依赖方向：renderer → layout-guard（单向，无循环）。
 */

/** 插入位置：决定 wrapper 相对原段落节点落在何处。 */
export interface InsertionTarget {
  /**
   * 'after'：作为 anchor 的下一个兄弟（普通 block 流，含 td 内段落 —— wrapper 仍在 cell 内）。
   * 'inside'：作为 anchor 的最后一个子节点（flex / grid item，避免增加 item 破坏布局）。
   */
  mode: 'after' | 'inside';
  /** 插入锚点 */
  anchor: HTMLElement;
}

/** 表格行级标签 —— 不能在其后直接插 div（会破坏表格结构）。 */
const TABLE_ROW_TAGS = new Set([
  'TR', 'THEAD', 'TBODY', 'TFOOT', 'CAPTION', 'COLGROUP', 'COL', 'TABLE',
]);

/**
 * 读取元素 display。内联 style 优先（jsdom 对外部 CSS 解析有限，真实浏览器两者皆可）。
 */
function readDisplay(el: HTMLElement): string {
  const inline = el.style.display;
  if (inline) return inline.toLowerCase();
  if (typeof getComputedStyle === 'function') {
    return getComputedStyle(el).display.toLowerCase();
  }
  return '';
}

/** node 是否是某 flex / grid 容器的直接 item。 */
function isDirectItemOfFlexGrid(parent: HTMLElement, node: HTMLElement): boolean {
  if (node.parentElement !== parent) return false;
  const display = readDisplay(parent);
  return (
    display === 'flex' ||
    display === 'inline-flex' ||
    display === 'grid' ||
    display === 'inline-grid'
  );
}

/** 取 cell 内最后一个块级子元素作为锚点（译文紧跟其后），无则返回 null。 */
function lastBlockChild(cell: HTMLElement): HTMLElement | null {
  const children = Array.from(cell.children);
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as HTMLElement;
    const d = readDisplay(child);
    if (d === '' || (d !== 'inline' && d !== 'inline-block')) {
      return child;
    }
  }
  return null;
}

/**
 * 解析容器感知的插入位置（架构第 9 节「排版破坏」对策）。
 *
 * - node 本身是表格行级（tr/thead/...）：下钻到首个 cell 内（cell 内最后块级子之后）。
 * - node 是 flex / grid 容器的直接 item：插到 node 内部末尾。
 * - 其余（含 td 内段落）：node 之后插兄弟 wrapper。
 */
export function resolveInsertionPoint(node: HTMLElement): InsertionTarget {
  if (TABLE_ROW_TAGS.has(node.tagName)) {
    const cell = node.querySelector<HTMLElement>('td, th');
    if (cell) {
      const lastBlock = lastBlockChild(cell);
      return { mode: 'after', anchor: lastBlock ?? cell };
    }
    return { mode: 'inside', anchor: node };
  }

  const parent = node.parentElement;
  if (parent && isDirectItemOfFlexGrid(parent, node)) {
    return { mode: 'inside', anchor: node };
  }

  return { mode: 'after', anchor: node };
}

/** 按 target 把 wrapper 插入 DOM。 */
export function insertWrapper(target: InsertionTarget, wrapper: HTMLElement): void {
  if (target.mode === 'inside') {
    target.anchor.appendChild(wrapper);
    return;
  }
  const parent = target.anchor.parentElement;
  if (parent) {
    parent.insertBefore(wrapper, target.anchor.nextSibling);
  } else {
    // anchor 已脱离 DOM，兜底追加到 anchor 内（正常流程不会走到）。
    target.anchor.appendChild(wrapper);
  }
}

/** 检测 wrapper 是否仍在 target 指定的位置（用于判断是否被页面 JS 重排覆盖）。 */
export function isAtTarget(target: InsertionTarget, wrapper: HTMLElement): boolean {
  if (!wrapper.isConnected) return false;
  const expectedParent =
    target.mode === 'inside' ? target.anchor : target.anchor.parentElement;
  return wrapper.parentElement === expectedParent;
}

interface WatchedEntry {
  /** 原段落节点（重插时重新解析插入点的基准） */
  original: HTMLElement;
  wrapper: HTMLElement;
  target: InsertionTarget;
  observer: MutationObserver;
  /** 重插进行中标志，避免 MutationObserver 回调递归 */
  reinserting: boolean;
}

/**
 * LayoutGuard —— 为每个已注入的译文 wrapper 建立重排守护。
 *
 * content script 单例：render 注入后调 watch；controller 关闭翻译时 dispose。
 */
export class LayoutGuard {
  private readonly watched = new Map<string, WatchedEntry>();
  private resizeObserver: ResizeObserver | undefined;

  constructor() {
    // jsdom 等环境无 ResizeObserver，降级跳过（基础防撑破由样式表 max-width/overflow-wrap 兜底）。
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver((entries) => this.handleResize(entries));
    }
  }

  /**
   * 监听一个已注入的 wrapper。页面 JS 删除 / 移动它时自动重插。
   * @param id 段落 id
   * @param original 原段落节点
   * @param wrapper 译文 wrapper（已插入 DOM）
   * @param target 可选，未传则按 original 重新解析
   */
  watch(
    id: string,
    original: HTMLElement,
    wrapper: HTMLElement,
    target?: InsertionTarget,
  ): void {
    this.unwatch(id);
    const resolved = target ?? resolveInsertionPoint(original);
    const observer = new MutationObserver(() => this.check(id));
    const parent = wrapper.parentElement ?? document.body;
    observer.observe(parent, { childList: true });
    this.watched.set(id, {
      original,
      wrapper,
      target: resolved,
      observer,
      reinserting: false,
    });
    this.resizeObserver?.observe(wrapper);
  }

  /** MutationObserver 回调：wrapper 偏离目标位置则重插。 */
  private check(id: string): void {
    const entry = this.watched.get(id);
    if (!entry || entry.reinserting) return;
    if (!isAtTarget(entry.target, entry.wrapper)) {
      this.reinsert(id);
    }
  }

  /** 重新解析插入点并插回（原节点可能也被重排，故重新解析）。 */
  private reinsert(id: string): void {
    const entry = this.watched.get(id);
    if (!entry) return;
    entry.reinserting = true;
    entry.observer.disconnect();
    const fresh = resolveInsertionPoint(entry.original);
    entry.target = fresh;
    insertWrapper(fresh, entry.wrapper);
    const parent = entry.wrapper.parentElement ?? document.body;
    entry.observer.observe(parent, { childList: true });
    entry.reinserting = false;
  }

  /** ResizeObserver 回调：译文撑破容器时收敛宽度，防止破坏布局。 */
  private handleResize(entries: ResizeObserverEntry[]): void {
    for (const entry of entries) {
      const el = entry.target as HTMLElement;
      const parent = el.parentElement;
      if (parent && el.scrollWidth > parent.clientWidth) {
        el.style.maxWidth = '100%';
        el.style.overflowWrap = 'anywhere';
      }
    }
  }

  /** 主动重新校验所有监听项（例如从后台切回标签页后调用）。 */
  recheckAll(): void {
    for (const id of this.watched.keys()) this.check(id);
  }

  /** 停止监听单个段落。 */
  unwatch(id: string): void {
    const entry = this.watched.get(id);
    if (!entry) return;
    this.resizeObserver?.unobserve(entry.wrapper);
    entry.observer.disconnect();
    this.watched.delete(id);
  }

  /** 释放全部监听（页面卸载 / 关闭翻译时调用）。 */
  dispose(): void {
    for (const id of Array.from(this.watched.keys())) this.unwatch(id);
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
  }
}
