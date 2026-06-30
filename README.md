# BatchTranslate

> 浏览器 AI 双语对照翻译扩展。对标沉浸式翻译，直击免费版痛点。MV3 / WXT / Preact，纯本地隐私。

沉浸式翻译好用，但免费版有两个硬伤：

1. **AI 智能体翻译用不了** —— 高级 AI 模型 / 智能体模式锁在 Pro 订阅里，免费用户只能用基础引擎。
2. **自定义模型每段单独请求，并发过高** —— 按段落逐条向 LLM 发请求，一个网页数百段落数百并发，触发 429 限流、卡顿、API 额度秒光。

外加 2025-08 沉浸式翻译的快照泄露事件（翻译结果存公开链接被搜索引擎抓取），隐私也成问题。

## 我们的解法

| 痛点 | BatchTranslate 方案 |
|---|---|
| 免费用不了 AI 智能体 | 自带 API Key 接任意 LLM（OpenAI / Claude / Gemini / DeepSeek / 本地 Ollama），可选智能体模式：自定义系统提示词、角色、术语库、风格预设 |
| 每段一请求并发爆炸 | **批量合并**：多段打包成一次请求（结构化 JSON 协议，id 一一对齐）+ **智能并发控制**（全局唯一 Service Worker 限流 + 令牌桶 + 429 退避）|
| 隐私泄露 | **纯本地**：无后端、无遥测、无分享链接；API Key 加密存本地；翻译原文仅在你与你的 LLM endpoint 之间流动 |

## 技术栈

- **Manifest V3** + **WXT**（Vite 内核，跨 Chrome/Edge/Firefox）
- **Preact + Signals**（轻量，扩展体积敏感）
- **IndexedDB (idb)** 本地缓存（LRU + TTL）
- **Web Crypto** API Key 加密（AES-GCM）
- **Vitest**（单测 + 集成）+ **Playwright**（e2e）

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

### 从源码构建（开发者）

需要 Node 20+ 与 pnpm。

```bash
pnpm install
pnpm build          # 产出 .output/chrome-mv3
pnpm zip            # 产出 Chrome 商店包 .output/chrome-mv3.zip
```

### 加载到 Chrome / Edge

1. `pnpm build` 后得到 `.output/chrome-mv3` 目录。
2. 打开 `chrome://extensions`，开启右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选 `.output/chrome-mv3` 目录。
4. 扩展图标出现在工具栏，点「BatchTranslate 设置」进入 options 页配置引擎。

## 使用

1. **配引擎**：打开 options 页 → 引擎管理 → 新增引擎（选 provider / 填 Base URL / Model）→ 保存 API Key（加密存本地）→ 自动设为当前引擎。
2. **开翻译**：打开任意网页，点扩展图标（popup）的开关，或点页面右下悬浮控制条的「▶ 翻译本页」。
3. **看双语对照**：译文以灰色块注入到原段落后，原文不动。
4. **二次访问命中缓存**：同页同引擎再次翻译，命中本地缓存，不重复请求 LLM。

### 支持的引擎 provider

| Provider | Base URL 示例 | 说明 |
|---|---|---|
| `openai` | `https://api.openai.com/v1` | OpenAI 官方 |
| `openai-compatible` | 用户自填 | DeepSeek / 通义 / 任意 OpenAI 兼容 endpoint |
| `anthropic` / `gemini` / `ollama` | — | P1 范围（接口已预留） |

P0 仅交付 OpenAI 兼容实现（覆盖 OpenAI / DeepSeek / 任意兼容 endpoint）。

## 配置

options 页可调：

- **翻译设置**：目标语言 / 源语言（自动检测）/ 模式（基础 / 智能体-P1）。
- **调度参数**：全局并发（1–10，默认 3）/ RPS（防 429，默认 2）/ 单批段数（默认 20）/ 最大重试（默认 5）/ TPM 限额（0=关闭）/ 输入占窗比（默认 0.7）。
- **缓存管理**：启用开关 / 容量上限 MB（LRU，默认 100）/ TTL 天（0=永久）/ 一键清空 / 命中统计。
- **UI 偏好**：显示原文 / 译文样式 / 仅悬停显示。

## 隐私

- **纯本地，无后端**：原文/译文仅在本地 Service Worker 与你填写的 LLM endpoint 之间流动，不经过任何本项目服务器。
- **零遥测**：不集成 GA / PostHog / Sentry，无崩溃上报。
- **Key 加密存储**：API Key 经 AES-GCM 加密后存本地，绝不进 storage.sync（云同步）。
- **无分享链接**：结果只存本地 IndexedDB，绝不生成可被搜索引擎抓取的公开链接。
- **数据去向透明**：悬浮控制条明示译文正发往哪个引擎 / endpoint。

## 测试

```bash
pnpm test       # Vitest 单测 + 流水线/渲染集成测试（321 项）
pnpm typecheck  # TypeScript 类型检查
pnpm e2e        # 先 build 再跑 Playwright e2e（需支持 MV3 SW 追踪的 Chromium 环境）
pnpm test:real  # 真实端点集成（需 BT_REAL_BASE_URL/BT_REAL_API_KEY/BT_REAL_MODEL 环境变量，内网端点可达时启用）
```

e2e 覆盖差异化点：translate-page（双语渲染 + 原文零污染 + 段落对齐）、batch-protocol（多段合并 + 部分失败重发）、cache（二次命中请求数为 0）、concurrency（在途不超 maxConcurrent）、sw-recovery（恢复 alarm）、config（options 配引擎生效）。mock LLM server 不依赖真实 API Key。

集成测试（`pnpm test`）覆盖真实流水线：`pipeline-integration`（真实 Stage 2 + mock 引擎：批量合并 / 缓存 / 并发 / 部分失败 / CANCEL）、`render-integration`（dom-walker + bilingual-renderer：双语注入 / 原文零污染 / 占位符还原 / 容器感知）、`real-endpoint-integration`（真实 OpenAI 兼容端点：英文段 → 中文译文 / id 对齐 / 批量合并 / 缓存命中）。

**真实端点集成**：`real-endpoint-integration.test.ts` 用真实 OpenAI 兼容端点驱动 `OpenAIEngine` + protocol + orchestrator + cache，验证插件确能端到端翻译。端点配置走环境变量（内网测试端点，非公开）：

```bash
BT_REAL_BASE_URL=http://192.168.3.3:8084/v1 \
BT_REAL_API_KEY=sk-... \
BT_REAL_MODEL=auto \
pnpm test:real
```

端点不可达或缺配置时自动 skip，不阻塞 `pnpm test`。

> 注：Playwright 对 MV3 Service Worker 的追踪在部分 Chromium/Playwright 版本组合下不可用；此时 e2e specs 经环境守卫 skip，真实翻译流水线由 `pnpm test` 的集成测试覆盖。

## 状态

✅ **v1.0.0 MVP 发布** —— P0 全部完成。任务拆分见 Multica 工作区 issue 看板（前缀 `TRA`）。

## 路线图

- **P0 MVP** ✅：网页双语翻译 + 批量协议 + 并发控制 + 多引擎 + 缓存 + 加密密钥 + e2e/集成测试
- **P1**：智能体模式（提示词/术语库/风格）+ 流式渲染 + 主密码派生密钥 + Anthropic/Gemini/Ollama 引擎 + 跨 SW 重启完整续传
- **P2**：PDF / 视频字幕 / 漫画 OCR / Epub / 悬停翻译

## License

MIT
