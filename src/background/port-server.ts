/**
 * 翻译 Port 服务端 —— Service Worker 侧的 chrome.runtime.onConnect 处理（架构 2.2）。
 *
 * 负责 per-tab 翻译长连接 `translate:<tabId>` 的生命周期：
 *   - onConnect：解析 tabId，登记 port，挂 onMessage/onDisconnect。
 *   - TRANSLATE_BATCH：解析上下文 → 交给 orchestrator.translateBatch（结果经 port 回传）。
 *   - CANCEL：orchestrator.cancel(tabId)。
 *   - onDisconnect（content 刷新 / tab 关闭）：中止该 tab 在途翻译，清理登记。
 *
 * 本模块只 import `src/shared/*` 与 orchestrator 的 DI 接口，不依赖 Stage 2 实现，
 * 也不直接依赖 @types/chrome（WXT/P0-1 落地前用结构化最小接口 ChromeRuntimeLike 桥接）。
 */
import { parseTranslatePortName } from '../shared/constants';
import { isCancel, isPortMessage, isTranslateBatch } from '../shared/messages';
import type { Orchestrator, OrchestratorPort, TranslateContext } from './orchestrator';
import type { SMToContentPortMessage } from '../shared/messages';

// ═══════════════════════════════════════════════════════════════════════════
// chrome.runtime 结构化最小接口（@types/chrome / WXT 未接入前的桥接类型）
// ═══════════════════════════════════════════════════════════════════════════

/** chrome.runtime.Port 形状（仅取 port-server 用到的能力）。 */
export interface ChromeRuntimePort {
  name: string;
  postMessage(msg: unknown): void;
  onMessage: { addListener(fn: (msg: unknown, port: ChromeRuntimePort) => void): void };
  onDisconnect: { addListener(fn: (port: ChromeRuntimePort) => void): void };
}

/** chrome 顶层结构（仅 runtime.onConnect）。 */
export interface ChromeRuntimeLike {
  runtime: {
    onConnect: { addListener(fn: (port: ChromeRuntimePort) => void): void };
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PortServerDeps
// ═══════════════════════════════════════════════════════════════════════════

export interface PortServerDeps {
  /** 共享编排器实例（由 runtime-deps 注入，broadcastStatus 已在编排器内部接好）。 */
  orchestrator: Orchestrator;
  /** 按当前 AppConfig 解析该 tab 的翻译上下文（活动引擎 / 调度参数 / 预算）。 */
  buildContext: (tabId: number) => Promise<TranslateContext>;
}

// ═══════════════════════════════════════════════════════════════════════════
// 实现
// ═══════════════════════════════════════════════════════════════════════════

/** chrome.runtime.Port → orchestrator 用的最小 Port（只暴露 postMessage）。 */
function toOrchestratorPort(port: ChromeRuntimePort): OrchestratorPort {
  return {
    postMessage(msg: SMToContentPortMessage): void {
      port.postMessage(msg);
    },
  };
}

/**
 * 注册翻译 Port 服务端。在 SW 入口（background.ts）调用一次。
 *
 * @returns 一个 cleanup 函数（主要给测试用；生产 SW 全生命周期常驻）。
 */
export function initPortServer(deps: PortServerDeps, runtime: ChromeRuntimeLike): () => void {
  // tabId → 活跃 port。用于 onDisconnect 清理（orchestrator 自身按 tabId 管理在途控制）。
  const activePorts = new Map<number, ChromeRuntimePort>();

  const onConnect = (port: ChromeRuntimePort): void => {
    const tabId = parseTranslatePortName(port.name);
    if (tabId === undefined) return; // 非翻译 port，交还其它监听器

    // 同 tab 新连接（SPA 重连 / content 重注入）：先中止上一轮在途，避免双发。
    if (deps.orchestrator.isActive(tabId)) {
      deps.orchestrator.cancel(tabId);
    }
    activePorts.set(tabId, port);

    port.onDisconnect.addListener(() => {
      if (activePorts.get(tabId) === port) activePorts.delete(tabId);
      // content 刷新 / tab 关闭 → 中止该 tab 在途翻译，释放并发槽。
      deps.orchestrator.cancel(tabId);
    });

    port.onMessage.addListener((msg: unknown) => {
      if (!isPortMessage(msg)) return;
      if (isTranslateBatch(msg)) {
        // 解析上下文后异步执行；结果/错误一律经 port 回传（RESULT/PROGRESS/ERROR/BATCH_DONE）。
        void deps
          .buildContext(tabId)
          .then((ctx) => deps.orchestrator.translateBatch(msg.items, ctx, toOrchestratorPort(port)))
          .catch((err) => {
            // buildContext 失败（如配置缺失）→ 整批 ERROR 回传，不让 SW 崩。
            const reason = err instanceof Error ? err.message : String(err);
            // 密钥库锁定（方案 b，TRA-22）：主密码已设但 SW 重启后未解锁 → 尽力弹出 popup
            // 解锁（Chrome 127+ 支持 SW 内 openPopup；不可用则用户手动点工具栏图标解锁）。
            if (err instanceof Error && err.name === 'LockedError') {
              tryOpenPopupForUnlock();
            }
            try {
              port.postMessage({ type: 'ERROR', id: '__batch__', reason });
            } catch {
              /* port 已断 */
            }
          });
      } else if (isCancel(msg)) {
        deps.orchestrator.cancel(tabId);
      }
    });
  };

  runtime.runtime.onConnect.addListener(onConnect);

  return () => {
    // 测试用 cleanup：生产 SW 常驻不卸载此监听（架构：监听随 SW 生命周期）。
    // chrome.runtime.onConnect.removeListener 在最小接口里未声明，故仅清表。
    activePorts.clear();
  };
}

/**
 * 密钥库锁定时尽力弹出 popup 解锁（架构 7.2 方案 b，TRA-22）。
 * chrome.action.openPopup 在 Chrome 127+ 可从 SW 调用；旧版本 / 无手势时拒绝，静默忽略。
 * 用 name 比对而非导入 LockedError 类，避免 port-server 依赖 secret-store（保持解耦）。
 */
function tryOpenPopupForUnlock(): void {
  const maybeChrome = globalThis as unknown as {
    chrome?: { action?: { openPopup?: () => Promise<void> } };
  };
  const openPopup = maybeChrome.chrome?.action?.openPopup;
  if (typeof openPopup !== 'function') return;
  try {
    const ret = openPopup.call(maybeChrome.chrome?.action);
    if (ret && typeof (ret as Promise<void>).catch === 'function') {
      (ret as Promise<void>).catch(() => {
        /* 无手势 / 不支持：用户手动点工具栏图标解锁 */
      });
    }
  } catch {
    /* 静默 */
  }
}
