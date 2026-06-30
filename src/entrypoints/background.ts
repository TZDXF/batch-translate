/**
 * Service Worker 入口（架构 2.1 / 3）。
 *
 * 职责（本任务 P0-7）：注册翻译 Port 长连接服务端（架构 2.2 translate:<tabId>）。
 *
 * ⚠️ 与 P0-1（TRA-2 脚手架）的协调：P0-1 产出的是 console.log 占位 + 初始化钩子留口；
 *    本文件在此注入翻译编排入口。合并时取并集（P0-1 的其它初始化 + 本文件的 port-server）。
 *
 * ⚠️ Stage 2 依赖：initRuntimeOrchestrator() 在 P0-3/4/5/6 合并前会抛错（见
 *    runtime-deps.ts）。此前 SW 启动仅记录告警，不崩溃；Stage 2 接入后自动生效。
 */
import { initPortServer } from '../background/port-server';
import type { ChromeRuntimeLike } from '../background/port-server';
import { initRuntimeOrchestrator } from '../background/runtime-deps';

// chrome 全局由 WXT/MV3 注入；未装 @types/chrome 前以结构化接口桥接（P0-1 落地后可去 cast）。
const chromeRuntime = (globalThis as unknown as { chrome?: ChromeRuntimeLike }).chrome;

if (chromeRuntime) {
  try {
    const portServerDeps = initRuntimeOrchestrator();
    initPortServer(portServerDeps, chromeRuntime);
    console.info('[bt] translate port server initialized');
  } catch (err) {
    // Stage 2 未接入时的预期错误：仅告警，等 P0-3/4/5/6 合并。
    console.warn('[bt] orchestrator wiring pending Stage 2:', err);
  }
} else {
  console.warn('[bt] chrome runtime unavailable (not in MV3 SW context)');
}

// 占位：onStartup / onInstalled / alarms 恢复注册在 P0-10（TRA-11）。
