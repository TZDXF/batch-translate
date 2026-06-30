/**
 * Service Worker 入口（架构 2.1 / 2.2）。
 *
 * 职责：
 *  - 处理一次性消息（popup/options → SW）：GET_STATUS / TOGGLE_TRANSLATE / SWITCH_ENGINE /
 *    SWITCH_MODE / GET_CONFIG / CONFIG_CHANGED。
 *  - 维护 per-tab 翻译状态并向 popup 广播 STATUS（进度实时更新）。
 *  - 接收 content 的 translate:<tabId> Port 长连接（翻译主通道），交由 port-server +
 *    orchestrator 处理真实翻译流水线（查缓存→打包→调度→引擎→协议解析→回传）。
 *  - 装配 SW 卸载恢复（chrome.alarms + storage.local 持久化队列）。
 *  - 配置变更时重载内存配置。
 */
import { defineBackground } from 'wxt/utils/define-background';
import type { FromSWMessages, RuntimeMessage } from '../shared/messages';
import {
  isConfigChanged,
  isGetConfig,
  isGetStatus,
  isRuntimeMessage,
  isSwitchEngine,
  isSwitchMode,
  isToggleTranslate,
} from '../shared/messages';
import type { TabTranslationState } from '../shared/types';
import { loadConfig, patchConfig, setActiveEngine } from '../background/config/config-store';
import { buildPortServerDeps, getStage2Modules, registerSetTabTranslation } from '../background/runtime-deps';
import { initPortServer } from '../background/port-server';
import type { ChromeRuntimeLike } from '../background/port-server';

interface TabState {
  state: TabTranslationState;
  progress: number;
}

const tabStates = new Map<number, TabState>();

function getTabState(tabId: number): TabState {
  return tabStates.get(tabId) ?? { state: 'idle', progress: 0 };
}

/** orchestrator（经 runtime-deps.broadcastStatus）调用：推进某 tab 的翻译状态并广播给 popup。 */
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

export default defineBackground(() => {
  // 启动加载一次配置（供后续 orchestrator/registry 使用）。
  void loadConfig();

  // ── 翻译编排器 + Port 服务端接线（Stage 3 集成，P0-12）────────────────────
  // orchestrator 串联缓存/打包/调度/引擎；port-server 处理 translate:<tabId> 长连接，
  // 收到 TRANSLATE_BATCH → buildContext → orchestrator.translateBatch，结果经 port 回传。
  registerSetTabTranslation(setTabTranslation);
  const portDeps = buildPortServerDeps(getStage2Modules());
  initPortServer(portDeps, chrome as unknown as ChromeRuntimeLike);
  console.info('[bt] translate orchestrator + port-server initialized');

  // ── SW 卸载恢复（P0-10 / TRA-11）──────────────────────────────────────────
  // chrome.alarms 每 30s 扫描 storage.local 持久化队列，为 tab 已重连的未完成批次
  // 触发幂等续传。content port 重连时由 port-server 触发 resumeForTab（见 port-server）。
  // 此处仅装配周期扫描；resume 实现由 orchestrator 经 ResumePort 提供（P1 完整接线，
  // MVP 阶段队列已落盘、扫描与清理生效，跨 SW 重启续传在 P0-10 已单测覆盖）。
  try {
    void setupRecoveryIfAvailable();
  } catch (err) {
    console.warn('[bt] recovery setup pending:', err);
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
});

/**
 * 装配 SW 卸载恢复（chrome.alarms 周期扫描 + 启动钩子）。
 * 懒加载 recovery 模块：其 ResumePort 续传依赖 orchestrator 的完整 resume 实现（P1），
 * MVP 阶段仅启用 alarm 扫描 + 孤儿/终态批次清理，保证持久化队列不无限增长。
 */
async function setupRecoveryIfAvailable(): Promise<void> {
  const { setupRecovery } = await import('../background/recovery');
  const inFlight = new Set<string>();
  setupRecovery({
    // MVP：续传端口暂用 no-op（orchestrator.resume 待 P1 完整实现）。
    // 队列落盘 / 扫描 / 清理仍生效；真正跨 SW 重启续传在 P0-10 单测覆盖 + P1 接线。
    resumePort: { async resume() {
      return { batchId: '', remainingMissing: [] };
    } },
    tabLookup: (tabId) => tabStates.has(tabId),
    inFlight,
  });
  console.info('[bt] recovery alarm armed');
}
