/**
 * content 侧翻译编排（架构 3 节 controller.ts）：开关 → 连接 Port → 提取段落 → 发批 →
 * 回填。本任务范围内打通「开关 / Port 主通道 / 进度与错误回显」。
 *
 * ★ 集成点（非本任务，留 seam）：
 *  - 段落提取：P0-8 dom-walker 的 extract(root)。此处 extractParagraphsStub 为占位。
 *  - 译文回填：P0-9 bilingual-renderer 在 RESULT 时注入双语节点。此处仅更新控制条进度。
 *  - 真实译文：P0-7 orchestrator 经 Port 回传 RESULT/PROGRESS/BATCH_DONE。
 */
import { translatePortName } from '../shared/constants';
import {
  isBatchDone,
  isError,
  isPortMessage,
  isProgress,
  isResult,
} from '../shared/messages';
import type { Item } from '../shared/types';
import { updateControlBar } from './floating-ui/mount';

let tabId: number | null = null;
let port: chrome.runtime.Port | null = null;
let on = false;
let doneCount = 0;
let total = 0;

/** content 无法直接读自身 tabId；通过内部握手向 SW 取（sender.tab.id）。 */
async function getMyTabId(): Promise<number | null> {
  try {
    const resp = (await chrome.runtime.sendMessage({ btInternal: 'tab-id' })) as { tabId?: number } | undefined;
    return typeof resp?.tabId === 'number' ? resp.tabId : null;
  } catch {
    return null;
  }
}

/** ★ 占位：真实提取由 P0-8 dom-walker 接入。这里取可见块级文本用于打通消息回路。 */
function extractParagraphsStub(): Item[] {
  const nodes = document.querySelectorAll('p, h1, h2, h3, li, blockquote');
  const items: Item[] = [];
  let i = 0;
  nodes.forEach((n) => {
    const t = (n.textContent ?? '').trim();
    if (t.length >= 2 && i < 50) items.push({ id: `p${i++}`, text: t });
  });
  return items;
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
  on = true;
  doneCount = 0;
  port = chrome.runtime.connect({ name: translatePortName(tid) });
  port.onMessage.addListener(onPortMessage);
  port.onDisconnect.addListener(() => {
    on = false;
    port = null;
    updateControlBar({ on: false, state: 'idle' });
  });

  const items = extractParagraphsStub();
  total = items.length;
  updateControlBar({ on: true, state: 'translating', progress: 0, error: null });
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
  updateControlBar({ on: false, state: 'idle', progress: 0 });
}

function onPortMessage(m: unknown): void {
  if (!isPortMessage(m)) return;
  if (isProgress(m)) {
    updateControlBar({ state: 'translating' });
  } else if (isResult(m)) {
    doneCount++;
    if (total > 0) updateControlBar({ progress: Math.min(1, doneCount / total) });
    // ★ P0-9 bilingual-renderer 在此回填译文节点。
  } else if (isError(m)) {
    updateControlBar({ state: 'error', error: m.reason });
  } else if (isBatchDone(m)) {
    updateControlBar({ state: 'done', progress: 1 });
  }
}
