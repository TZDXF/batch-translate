# Changelog

本项目变更记录。版本号遵循 [SemVer](https://semver.org/)。

## [Unreleased]

### 变更

- **设置页改为独立网页**（TRA-30）：`options_ui.open_in_tab` 由 `false` 改为 `true`，设置页以整标签页（独立网页）打开，不再在 `chrome://extensions` 内以嵌入式弹窗呈现。通过 options 入口 HTML 的 `<meta name="manifest.openInTab" content="true" />` 声明（WXT 入口驱动字段）。

## [1.0.0] — 2026-06-30

首个 MVP 发布。对标沉浸式翻译免费版痛点，交付浏览器 AI 双语翻译扩展核心能力。

### 新增

- **批量合并翻译协议**（P0-4 / TRA-5）：多段打包成一次 LLM 请求，结构化 JSON `{items:[{id,text}]}` 协议 + id 一一对齐 + 容错解析（`<json>`/代码块/首对象兜底）+ 整批失败逐级降级（20→4×5→单段）+ 缺段单独重发不重翻已对齐段。
- **智能并发控制**（P0-5 / TRA-6）：全局唯一 Service Worker 限流，有界并发（gate）+ 令牌桶（RPS / 可选 TPM）+ 429 退避（Retry-After 取大、指数退避 ±20% jitter）+ AIMD 降速恢复。
- **本地缓存**（P0-6 / TRA-7）：IndexedDB（idb）缓存原文 hash→译文，sha256 cache-key（原文+引擎+提示词指纹+目标语），LRU 淘汰 + TTL + 命中计数统计。缓存命中段不发请求。
- **多引擎适配层**（P0-3 / TRA-4）：统一 `Engine` 接口，P0 交付 OpenAI 兼容（覆盖 OpenAI / DeepSeek / 任意兼容 endpoint）。Anthropic / Gemini / Ollama 接口预留（P1）。原生 fetch，AbortSignal 透传。
- **DOM 提取器**（P0-8 / TRA-8）：dom-walker 找可译块级段落 + block-classifier 分类正文/导航/代码 + inline-markup 内联标签 `[[n]]` 占位符保护（防 LLM 重排错位）+ 稳定段落 id（文档序+文本哈希）。
- **双语对照渲染**（P0-9 / TRA-9）：原段落后注入 `.bt-translation` wrapper，原文属性零污染；容器感知插入（表格/flex/grid 不破结构）；layout-guard MutationObserver 防页面 JS 重排删除译文；显示模式（双语/仅译文/仅原文）+ 样式预设（normal/blur/underline/highlight）。
- **翻译编排器**（P0-7 / TRA-10）：串联缓存→打包→调度→引擎→协议解析→回传；CANCEL 经 AbortController 中止在途；port 断连视为取消。
- **Service Worker 卸载恢复**（P0-10 / TRA-11）：批次状态落 storage.local（每批一个扁平键）+ chrome.alarms 每 30s 扫描 + 幂等续传（只重翻 missing 段）+ 孤儿/终态批次清理。
- **Options / Popup UI**（P0-11 / TRA-12）：Preact + Signals 轻量 UI。Options：引擎管理（增删改 + API Key 加密）+ 翻译设置 + 调度参数 + 缓存管理 + 隐私说明。Popup：开关 / 进度 / 引擎切换。
- **加密密钥存储**（TRA-4 / TRA-12）：API Key 经 AES-GCM 加密落本地，主密钥存 storage.local（方案 a），绝不进 storage.sync（云同步）。
- **跨上下文消息契约**（P0-2 / TRA-3）：discriminated union 单一事实来源 `src/shared/messages.ts`；低频命令用 `runtime.sendMessage`，翻译主通道用 Port 长连接 `translate:<tabId>`。
- **WXT 工程脚手架**（P0-1 / TRA-2）：三入口（background / content / options+popup）+ Vitest 单测基座 + Playwright e2e 基座。
- **Playwright e2e + 集成测试**（P0-12 / TRA-13）：mock LLM server + 加载 `.output/chrome-mv3` 真实扩展的 e2e 套件（translate-page / batch-protocol / cache / concurrency / sw-recovery / config）；真实 Stage 2 模块装配的流水线集成测试（批量合并 / 缓存命中 / 并发上限 / 部分失败重发 / CANCEL）+ 渲染集成测试（双语注入 / 原文零污染 / 占位符还原 / 容器感知）+ 真实端点集成测试（真实 OpenAI 兼容端点驱动 `OpenAIEngine` + orchestrator + cache，验证英文段 → 中文译文 / id 对齐 / 批量合并 / 缓存命中；端点不可达时 skip）。

### 变更

- Stage 3 集成：`runtime-deps.getStage2Modules()` 装配真实 Stage 2 模块（protocol/packer/scheduler/retry/cache/engines）为 orchestrator DI 契约；`background.ts` 接线 port-server + recovery；`content/controller.ts` 接线 dom-walker + bilingual-renderer + layout-guard + inline-markup。
- 版本号 0.1.0 → 1.0.0。

### 已知限制（P1/P2 路线图）

- 智能体模式（角色/术语库/风格预设）为 P1，接口已预留但 options 中禁用。
- 流式渲染（STREAM_CHUNK）为 P1 预留。
- 引擎仅交付 OpenAI 兼容；Anthropic / Gemini / Ollama 为 P1。
- 主密钥为方案 a（storage.local 混淆级），P1 升级主密码 PBKDF2 派生（方案 b）。
- Playwright e2e 的 MV3 Service Worker 追踪在部分 Chromium/Playwright 版本组合下不可用，e2e specs 经环境守卫 skip；真实流水线由 `pnpm test` 集成测试覆盖。
- 跨 SW 重启续传的完整 resume（orchestrator.resume）为 P1；MVP 队列已落盘 + 扫描清理生效。
