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
import type { Item, Paragraph } from '../shared/types';
import { extract } from './extractor/dom-walker';
import { restore, serialize } from './extractor/inline-markup';
import type { Placeholder } from '../shared/types';
import { ParagraphRegistry } from './paragraph-registry';
import { render, type RenderHandle } from './renderer/bilingual-renderer';
import { LayoutGuard } from './renderer/layout-guard';
import { loadConfig } from '../background/config/config-store';
import { updateControlBar } from './floating-ui/mount';

let tabId: number | null = null;
let port: chrome.runtime.Port | null = null;
let on = false;
let doneCount = 0;
let total = 0;
let lastConfigUi: { showOriginal: boolean; translationStyle: string } | null = null;

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
    lastConfigUi = { showOriginal: cfg.ui.showOriginal, translationStyle: cfg.ui.translationStyle };
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
  const displayMode = lastConfigUi?.showOriginal === false ? 'translation' : 'bilingual';
  const style = (lastConfigUi?.translationStyle as 'normal' | 'blur' | 'underline' | 'highlight' | undefined) ?? 'normal';
  const handle = render(paragraph, translated, { displayMode, style, restoreMarkup: restorer });
  handles.set(id, handle);
  registry.setWrapper(id, handle.wrapper);
  registry.setStatus(id, 'translated');
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
