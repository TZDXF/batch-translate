// 消息契约（discriminated union），content / background / options / popup 共享。
// 详见 docs/ARCHITECTURE.md §2.2 通信协议。Stage 1 仅占位骨架，后续 issue 补全字段。

/**
 * 一次性消息（chrome.runtime.sendMessage）：低频、无状态命令。
 * popup/options → background。
 */
export type RuntimeMessage =
  | { type: 'GET_STATUS'; tabId: number }
  | { type: 'TOGGLE_TRANSLATE'; tabId: number; on: boolean }
  | { type: 'SWITCH_ENGINE'; engineId: string }
  | { type: 'CONFIG_CHANGED' };

/**
 * Port 长连接消息（chrome.runtime.connect）：高频、流式、双向，翻译任务主通道。
 * content ↔ background（connect name: `translate:<tabId>`）。
 */
export type PortMessage =
  | { type: 'TRANSLATE_BATCH'; items: Array<{ id: string; text: string }> }
  | { type: 'CANCEL' }
  | { type: 'PROGRESS'; id: string; status: string }
  | { type: 'RESULT'; id: string; translated: string }
  | { type: 'ERROR'; id: string; reason: string }
  | { type: 'BATCH_DONE'; batchId: string };
