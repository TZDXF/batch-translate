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

## 状态

🚧 开发中 —— MVP (P0) 阶段。任务拆分见 Multica 工作区 issue 看板（前缀 `TRA`）。

## 路线图

- **P0 MVP**：网页双语翻译 + 批量协议 + 并发控制 + 多引擎 + 缓存 + 加密密钥
- **P1**：智能体模式（提示词/术语库/风格）+ 流式渲染 + 主密码派生密钥
- **P2**：PDF / 视频字幕 / 漫画 OCR / Epub / 悬停翻译

## License

MIT
