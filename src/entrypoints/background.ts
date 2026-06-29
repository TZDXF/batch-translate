import { defineBackground } from 'wxt/utils/define-background';

/**
 * Service Worker 入口（MV3 background）。
 * Stage 1 占位：仅打印启动日志。
 *
 * 后续在此初始化（见 docs/ARCHITECTURE.md §2.1 / §2.2 / §2.3）：
 * - orchestrator：翻译编排核心（批量打包 + 并发控制）
 * - cache-store：IndexedDB 缓存（SW 可访问）
 * - recovery：chrome.alarms 恢复未完成队列
 * - runtime.onMessage：低频一次性消息（GET_STATUS / TOGGLE_TRANSLATE / SWITCH_ENGINE / CONFIG_CHANGED）
 * - runtime.onConnect：Port 长连接翻译主通道（translate:<tabId>）
 */
export default defineBackground(() => {
  console.log('[BatchTranslate] background service worker loaded');

  // TODO(后续 issue): 初始化调度器 / 缓存 / 队列恢复，并注册消息与 Port 监听。
});
