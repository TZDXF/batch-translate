/**
 * Service Worker 入口（架构 2.1 / 2.2）。
 *
 * 职责（P0-11 范围）：
 *  - 处理一次性消息（popup/options → SW）：GET_STATUS / TOGGLE_TRANSLATE / SWITCH_ENGINE /
 *    SWITCH_MODE / GET_CONFIG / CONFIG_CHANGED。
 *  - 维护 per-tab 翻译状态并向 popup 广播 STATUS（进度实时更新）。
 *  - 接收 content 的 translate:<tabId> Port 长连接（翻译主通道）。
 *  - 配置变更时重载内存配置。
 *
 * ★ 集成点（非本任务范围，留 seam）：
 *  - 真实翻译流水线由 P0-7 orchestrator 接管：收到 TRANSLATE_BATCH 后查缓存→打包→调度→
 *    引擎→协议解析→port 回传 RESULT/PROGRESS/BATCH_DONE。orchestrator 通过本文件导出的
 *    setTabTranslation() 驱动 popup 进度。
 *  - 队列持久化 / SW 卸载续传由 P0-10 接入。
 * 本文件只打通「消息回路 + 状态广播」，保证 UI 端到端可控。
 */
import { defineBackground } from 'wxt/utils/define-background';
import type { FromSWMessages, RuntimeMessage } from '../shared/messages';
import type { Item } from '../shared/types';
import {
  isConfigChanged,
  isGetConfig,
  isGetStatus,
  isPortMessage,
  isRuntimeMessage,
  isSwitchEngine,
  isSwitchMode,
  isToggleTranslate,
  isTranslateBatch,
  isCancel,
} from '../shared/messages';
import type { TabTranslationState } from '../shared/types';
import { parseTranslatePortName } from '../shared/constants';
import { loadConfig, patchConfig, setActiveEngine } from '../background/config/config-store';
import { initRuntimeOrchestrator } from '../background/runtime-deps';

interface TabState {
  state: TabTranslationState;
  progress: number;
}

const tabStates = new Map<number, TabState>();
const translatePorts = new Map<number, chrome.runtime.Port>();

function getTabState(tabId: number): TabState {
  return tabStates.get(tabId) ?? { state: 'idle', progress: 0 };
}

/** orchestrator（P0-7）调用：推进某 tab 的翻译状态并广播给 popup。 */
export function setTabTranslation(tabId: number, state: TabTranslationState, progress: number): void {
  tabStates.set(tabId, { state, progress });
  void broadcastStatus(tabId);
}

function broadcastStatus(tabId: number): Promise<void> {
  const s = getTabState(tabId);
  return chrome.runtime
    .sendMessage({ type: 'STATUS', tabId, state: s.state, progress: s.progress } satisfies FromSWMessages)
    .catch(() => {
      /* popup 未打开时无监听者，忽略 */
    });
}

/** 把命令中继到目标 tab 的 content script（TOGGLE_TRANSLATE / SWITCH_*）。 */
function relayToContent(tabId: number, msg: RuntimeMessage): Promise<void> {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {
    /* 该 tab 无 content script（如 chrome:// 页）时忽略 */
  });
}

/** 处理 popup/options → SW 的命令。 */
async function handleCommand(msg: RuntimeMessage): Promise<FromSWMessages | undefined> {
  if (isGetStatus(msg)) {
    const s = getTabState(msg.tabId);
    return { type: 'STATUS', tabId: msg.tabId, state: s.state, progress: s.progress };
  }
  if (isToggleTranslate(msg)) {
    setTabTranslation(msg.tabId, msg.on ? 'translating' : 'idle', 0);
    await relayToContent(msg.tabId, msg);
    return undefined;
  }
  if (isSwitchEngine(msg)) {
    await setActiveEngine(msg.engineId);
    return undefined;
  }
  if (isSwitchMode(msg)) {
    await patchConfig({ mode: msg.mode });
    return undefined;
  }
  if (isGetConfig(msg)) {
    return { type: 'CONFIG', config: await loadConfig() };
  }
  if (isConfigChanged(msg)) {
    // options 配置变更：重载内存配置（架构 2.2 CONFIG_CHANGED → SW 重载）。
    await loadConfig();
    return undefined;
  }
  return undefined;
}

/** ★ 集成点：P0-7 orchestrator 接管真实翻译。此处仅记录、保活通道、设状态。 */
function onTranslateBatchStub(tabId: number, itemCount: number, _items: Item[]): void {
  console.info(`[BatchTranslate] 收到 ${itemCount} 段翻译请求（tab ${tabId}），等待 orchestrator(P0-7) 处理`);
  setTabTranslation(tabId, 'translating', 0);
}

export default defineBackground(() => {
  // 启动加载一次配置（供后续 orchestrator/registry 使用）。
  void loadConfig();

  // ── 翻译编排器（P0-7 orchestrator）接线 ────────────────────────────────
  // initRuntimeOrchestrator() 串联缓存 / 打包 / 调度 / 引擎；Stage 2 依赖全部就绪后生效,
  // 此前仅告警不崩溃（见 runtime-deps.ts）。
  try {
    initRuntimeOrchestrator();
    console.info('[bt] translate orchestrator initialized');
  } catch (err) {
    console.warn('[bt] orchestrator wiring pending dependencies:', err);
  }

  // ── 一次性消息 ──────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
    // 内部握手：content 无法直接读自身 tabId，向 SW 取 sender.tab.id（不在 RuntimeMessage
    // 公共契约内，仅 content↔SW 内部约定）。
    if (msg && typeof msg === 'object' && (msg as { btInternal?: unknown }).btInternal === 'tab-id') {
      sendResponse({ tabId: sender.tab?.id ?? null });
      return false;
    }
    if (!isRuntimeMessage(msg)) return false;
    handleCommand(msg)
      .then((resp) => sendResponse(resp ?? null))
      .catch(() => sendResponse(null));
    return true; // 异步响应
  });

  // ── Port 长连接（翻译主通道） ───────────────────────────────────────────
  chrome.runtime.onConnect.addListener((port) => {
    const tabId = parseTranslatePortName(port.name);
    if (tabId == null) return; // 非翻译 Port，忽略
    translatePorts.set(tabId, port);
    setTabTranslation(tabId, 'translating', 0);

    port.onMessage.addListener((m: unknown) => {
      if (!isPortMessage(m)) return;
      if (isTranslateBatch(m)) {
        onTranslateBatchStub(tabId, m.items.length, m.items);
      } else if (isCancel(m)) {
        setTabTranslation(tabId, 'idle', 0);
      }
    });
    port.onDisconnect.addListener(() => {
      translatePorts.delete(tabId);
      const cur = tabStates.get(tabId);
      if (cur && cur.state === 'translating') setTabTranslation(tabId, 'idle', cur.progress);
    });
  });
});
