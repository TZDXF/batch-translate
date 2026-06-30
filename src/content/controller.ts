/**
 * content 侧翻译编排（架构 3 节 controller.ts）：开关 → 连接 Port → 提取段落 → 发批 →
 * 回填译文。Stage 3 集成（P0-12）后接真实模块：
 *  - 段落提取：P0-8 dom-walker.extract(root) + paragraph-registry 登记 id↔DOM 映射。
 *  - 译文回填：P0-9 bilingual-renderer.render + inline-markup.restore 还原内联标记 + layout-guard 防重排。
 *  - 真实译文：P0-7 orchestrator 经 Port 回传 RESULT/PROGRESS/BATCH_DONE/ERROR。
 */
import { translatePortName } from '../shared/constants';
import {
  isBatchDone,
  isError,
  isPortMessage,
  isProgress,
  isResult,
} from '../shared/messages';
import type { DisplayMode, Item, Paragraph } from '../shared/types';
import { extract } from './extractor/dom-walker';
import { restore, serialize } from './extractor/inline-markup';
import type { Placeholder } from '../shared/types';
import { ParagraphRegistry } from './paragraph-registry';
import { render, type RenderActions, type RenderHandle } from './renderer/bilingual-renderer';
import { LayoutGuard } from './renderer/layout-guard';
import { loadConfig } from '../background/config/config-store';
import { updateControlBar } from './floating-ui/mount';
import { evictCache, writebackCache } from './cache-access';

let tabId: number | null = null;
let port: chrome.runtime.Port | null = null;
let on = false;
let doneCount = 0;
let total = 0;
let lastConfigUi: { showOriginal: boolean; translationStyle: string; displayMode: DisplayMode } | null = null;
/** 当前显示模式（快捷键 cycleDisplayMode 切换，运行态镜像 config.ui.displayMode）。 */
let displayMode: DisplayMode = 'bilingual';
/** 最近悬停的段落 id —— 重译快捷键的目标（无鼠标时回退到首个已渲染段）。 */
let lastHoveredId: string | null = null;

const registry = new ParagraphRegistry();
const layoutGuard = new LayoutGuard();
// paragraphId → 渲染句柄（RESULT 回填 / ERROR 占位 / 关闭时移除）。
const handles = new Map<string, RenderHandle>();

/** content 无法直接读自身 tabId；通过内部握手向 SW 取（sender.tab.id）。 */
async function getMyTabId(): Promise<number | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({ btInternal: 'tab-id' })) as { tabId?: number } | undefined;
    return typeof resp?.tabId === 'number' ? resp.tabId : null;
  } catch {
    return null;
  }
}

/**
 * 用 P0-8 dom-walker 提取可翻译段落并登记到 registry。
 * 返回发给 SW 的 Item[]（仅 id + text，不含 DOM 引用——不可跨 chrome 边界）。
 */
function extractParagraphs(): Item[] {
  registry.clear();
  const paragraphs = extract(document.body);
  // dom-walker 产出 element（Element），registry/renderer 用 node（HTMLElement）——这里补齐。
  const withNodes = paragraphs.map((p) => ({ ...p, node: p.element as HTMLElement }));
  registry.registerMany(withNodes);
  return withNodes.map((p) => ({ id: p.id, text: p.text }));
}

export function isTranslating(): boolean {
  return on;
}

/** 切换本页翻译开关（控制条按钮 / popup 经 SW 中继均走此入口）。 */
export async function toggleTranslation(): Promise<void> {
  if (tabId == null) tabId = await getMyTabId();
  if (tabId == null) {
    updateControlBar({ error: '无法识别当前标签页' });
    return;
  }
  if (on) await stopTranslation();
  else await startTranslation(tabId);
}

export async function startTranslation(tid: number): Promise<void> {
  // 拉一次 UI 配置（显示模式 / 样式预设）供渲染使用。
  try {
    const cfg = await loadConfig();
    displayMode = cfg.ui.displayMode;
    lastConfigUi = { showOriginal: cfg.ui.showOriginal, translationStyle: cfg.ui.translationStyle, displayMode: cfg.ui.displayMode };
  } catch {
    lastConfigUi = null;
  }

  on = true;
  doneCount = 0;
  port = chrome.runtime.connect({ name: translatePortName(tid) });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    on = false;
    port = null;
    updateControlBar({ on: false, state: 'idle' });
  });

  const items = extractParagraphs();
  total = items.length;
  updateControlBar({ on: true, state: 'translating', progress: 0, error: null });

  if (items.length === 0) {
    // 无可翻译段落：直接收尾，避免发空批。
    updateControlBar({ state: 'done', progress: 1 });
    on = false;
    port.disconnect();
    port = null;
    return;
  }
  port.postMessage({ type: 'TRANSLATE_BATCH', items });
}

export async function stopTranslation(): Promise<void> {
  on = false;
  try {
    port?.postMessage({ type: 'CANCEL' });
  } catch {
    /* port 已断 */
  }
  try {
    port?.disconnect();
  } catch {
    /* noop */
  }
  port = null;
  teardownRendering();
  updateControlBar({ on: false, state: 'idle', progress: 0 });
}

/** 移除全部已注入译文 wrapper + 停止 layout-guard 监听。 */
function teardownRendering(): void {
  for (const id of [...handles.keys()]) {
    const h = handles.get(id);
    layoutGuard.unwatch(id);
    h?.remove();
    handles.delete(id);
  }
  registry.clear();
}

/** 把译文回填到原段落后的 wrapper（P0-9 渲染 + P0-8 inline-markup 还原）。 */
function applyResult(id: string, translated: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  const placeholders = paragraphPlaceholders(id);
  const restorer = (text: string): Node[] => {
    // 有占位符则还原内联 DOM；无则纯文本（占位符原样显示，不影响功能）。
    if (placeholders && placeholders.length > 0) {
      return [restore(text, placeholders, document)];
    }
    return [document.createTextNode(text)];
  };
  const existing = handles.get(id);
  if (existing) {
    existing.setText(translated);
    return;
  }
  const paragraph: Paragraph = {
    id: entry.id,
    text: entry.sourceText,
    node: entry.node,
  };
  const mode = displayMode;
  const style = (lastConfigUi?.translationStyle as 'normal' | 'blur' | 'underline' | 'highlight' | undefined) ?? 'normal';
  const actions: RenderActions = {
    retranslate: () => { void retranslateParagraph(id); },
    edit: (t: string) => { void onEditTranslation(id, t); },
    copy: () => onCopyTranslation(id),
  };
  const handle = render(paragraph, translated, { displayMode: mode, style, restoreMarkup: restorer, actions });
  handles.set(id, handle);
  registry.setWrapper(id, handle.wrapper);
  registry.setStatus(id, 'translated');
  // 悬停记录：重译快捷键的目标段。
  handle.wrapper.addEventListener('mouseenter', () => { lastHoveredId = id; });
  // 防重排：页面 JS 删除/移动 wrapper 时自动重插。
  layoutGuard.watch(id, entry.node, handle.wrapper, handle.target);
}

/** 占位符映射：registry 不存 placeholders，需从 DOM 重新序列化取（提取时未持久化）。 */
function paragraphPlaceholders(id: string): Placeholder[] | undefined {
  const entry = registry.get(id);
  if (!entry) return undefined;
  // re-serialize 取占位符（serialize 幂等，占位符序号稳定）。
  const { placeholders } = serialize(entry.node);
  return placeholders;
}

/** 标记失败段落，显示原位错误占位（不影响其他段）。 */
function applyError(id: string, reason: string): void {
  const entry = registry.get(id);
  if (!entry) return;
  const existing = handles.get(id);
  if (existing) {
    existing.markError(reason);
    return;
  }
  // 无 wrapper 时先渲染空译文再标错。
  const paragraph: Paragraph = { id: entry.id, text: entry.sourceText, node: entry.node };
  const handle = render(paragraph, '', { displayMode: 'bilingual' });
  handle.markError(reason);
  handles.set(id, handle);
  registry.setStatus(id, 'error', reason);
}

/**
 * 手动重译单段（P1-3）：先逐出该段缓存 → 经 Port 单发 TRANSLATE_BATCH（batch=1 由 packer
 * 自然成批）→ orchestrator 缓存 miss 强制重发 → 成功后 orchestrator 自动回写缓存。
 * 需要翻译已开启（Port 在线）；未开启时提示用户先开启。
 */
export async function retranslateParagraph(id: string): Promise<void> {
  const entry = registry.get(id);
  if (!entry) return;
  if (!port || !on) {
    updateControlBar({ error: '请先开启翻译后再重译' });
    return;
  }
  try {
    const cfg = await loadConfig();
    await evictCache(entry.sourceText, cfg);
  } catch {
    /* 缓存逐出失败不阻塞重译 */
  }
  // 清掉可能的错误占位，标记翻译中。
  handles.get(id)?.clearError();
  registry.setStatus(id, 'translating');
  updateControlBar({ state: 'translating', error: null });
  port.postMessage({ type: 'TRANSLATE_BATCH', items: [{ id, text: entry.sourceText }] });
}

/** 重译「当前段」：优先最近悬停段，回退首个已渲染段。 */
export async function retranslateCurrent(): Promise<void> {
  const id = lastHoveredId ?? [...handles.keys()][0];
  if (!id) return;
  await retranslateParagraph(id);
}

/**
 * 编辑译文回写缓存（P1-3）：用户在编辑态保存新译文 → 立即更新 wrapper 显示 →
 * 回写 IndexedDB 覆盖该段 cache entry（复用 P0-6 cache-key 契约）。
 * 二次访问该段时 orchestrator 命中被覆盖的缓存值（验收项）。
 */
export async function onEditTranslation(id: string, newText: string): Promise<void> {
  const entry = registry.get(id);
  const handle = handles.get(id);
  if (handle) handle.setText(newText);
  if (!entry) return;
  try {
    const cfg = await loadConfig();
    await writebackCache(entry.sourceText, newText, cfg);
  } catch {
    /* 回写失败不影响本地显示，仅缓存未更新 */
  }
}

/** 复制译文到剪贴板。 */
export function onCopyTranslation(id: string): void {
  const handle = handles.get(id);
  const text = handle?.getText() ?? '';
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* 剪贴板不可用时静默 */
  }
}

/** 当前显示模式（快捷键展示 / content 入口用）。 */
export function getDisplayMode(): DisplayMode {
  return displayMode;
}

/**
 * 循环切换显示模式（原文 / 译文 / 双显，P1-3 快捷键）：bilingual → translation → original → bilingual。
 * 立即应用到全部已渲染 wrapper，并持久化到 config.ui.displayMode 供下次进入页面沿用。
 */
export async function cycleDisplayMode(): Promise<void> {
  const next: DisplayMode =
    displayMode === 'bilingual' ? 'translation' : displayMode === 'translation' ? 'original' : 'bilingual';
  displayMode = next;
  for (const handle of handles.values()) handle.setDisplayMode(next);
  try {
    const { patchConfig } = await import('../background/config/config-store');
    await patchConfig({ ui: { displayMode: next } });
  } catch {
    /* 持久化失败不影响本次切换 */
  }
}

function onPortMessage(m: unknown): void {
  if (!isPortMessage(m)) return;
  if (isProgress(m)) {
    if (m.status === 'translating' || m.status === 'pending') {
      updateControlBar({ state: 'translating' });
    }
  } else if (isResult(m)) {
    doneCount++;
    if (total > 0) updateControlBar({ progress: Math.min(1, doneCount / total) });
    applyResult(m.id, m.translated);
  } else if (isError(m)) {
    applyError(m.id, m.reason);
    updateControlBar({ state: 'error', error: m.reason });
  } else if (isBatchDone(m)) {
    // 批次完成：进度已随 RESULT 累加；全部 done 时控制条收尾。
    if (doneCount >= total) updateControlBar({ state: 'done', progress: 1 });
  }
}
