# BatchTranslate

> 浏览器 AI 双语对照翻译扩展。对标沉浸式翻译，直击免费版痛点。

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
- **IndexedDB (idb)** 本地缓存
- **Vitest + Playwright** 测试

详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发

前置：Node ≥ 20.12、[pnpm](https://pnpm.io)。

```bash
pnpm install            # 安装依赖（postinstall 自动跑 wxt prepare 生成 .wxt 类型）

pnpm dev                # 开发模式：HMR + 自动重载（Chrome）
pnpm dev:firefox        # 开发模式：Firefox
pnpm build              # 生产构建 → .output/chrome-mv3（可直接加载的扩展）
pnpm build:firefox      # 构建 Firefox 版本
pnpm zip                # 打包发布 zip（.output/batch-translate-chrome-mv3.zip）
pnpm zip:firefox

pnpm test               # 单元测试（Vitest）
pnpm test:watch         # 单元测试 watch 模式
pnpm e2e                # e2e 测试（Playwright，扩展加载流程，占位待启用）

pnpm lint               # ESLint
pnpm typecheck          # tsc 类型检查（先 wxt prepare 再 tsc --noEmit）
```

**本地加载扩展（Chrome）：**

1. `pnpm build`
2. 打开 `chrome://extensions`，开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择 `.output/chrome-mv3` 目录
4. 点击工具栏 BatchTranslate 图标打开 popup；右键扩展 → 选项 打开 options 页

## 目录结构

与 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §3 一致。当前仓库为 Stage 1 基座，已落地加粗部分，其余模块在后续 issue 实现。

```
batch-translate/
├── .github/workflows/ci.yml        # CI：lint + typecheck + build + test
├── docs/ARCHITECTURE.md            # 架构设计
├── wxt.config.ts                   # WXT 构建配置（srcDir / manifest / Preact JSX）
├── vitest.config.ts                # 单测配置
├── playwright.config.ts            # e2e 配置
├── e2e/smoke.spec.ts               # 扩展加载 e2e（占位，skip）
└── src/
    ├── manifest.ts                 # WXT manifest 定义（MV3：storage + activeTab + 动态 host）
    ├── entrypoints/
    │   ├── background.ts           # Service Worker 入口（占位）
    │   ├── content.ts              # content script 入口（<all_urls>，占位）
    │   ├── options/                # Options 页（Preact 壳）index.html + index.tsx
    │   └── popup/                  # Popup（Preact 壳）index.html + index.tsx
    ├── shared/
    │   ├── messages.ts             # 消息契约（discriminated union，两端共享）
    │   ├── constants.ts            # 引擎列表 / 默认参数
    │   └── types.ts                # 共享类型（Paragraph / Batch / …）
    ├── __tests__/smoke.test.ts     # 工程冒烟测试
    ├── background/                 # 翻译编排核心（后续 issue）
    ├── content/                    # DOM 提取 + 双语渲染（后续 issue）
    ├── options/                    # Options 页逻辑（后续 issue）
    └── popup/                      # Popup 逻辑（后续 issue）
```

构建产物 `.output/`、WXT 中间产物 `.wxt/`、测试产物 `coverage/` `playwright-report/` `test-results/` 均已在 `.gitignore` 中忽略。

## 状态

🚧 开发中 —— MVP (P0) 阶段。任务拆分见 Multica 工作区 issue 看板（前缀 `TRA`）。

## 路线图

- **P0 MVP**：网页双语翻译 + 批量协议 + 并发控制 + 多引擎 + 缓存 + 加密密钥
- **P1**：智能体模式（提示词/术语库/风格）+ 流式渲染 + 主密码派生密钥
- **P2**：PDF / 视频字幕 / 漫画 OCR / Epub / 悬停翻译

## License

MIT
