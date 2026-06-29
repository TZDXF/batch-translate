# BatchTranslate 架构设计

对标沉浸式翻译免费版痛点，差异化 = 批量合并 + 智能并发 + 本地缓存 + 自带 Key 任意 LLM。

## 1. 技术栈选型

| 维度 | 选型 | 理由 |
|---|---|---|
| 构建框架 | **WXT** | 基于 Vite，原生支持 MV3，自动处理 content script HMR、多浏览器 manifest、polyfill。比 CRXJS 更专注扩展场景，跨 Firefox/Chrome/Edge 一套配置。 |
| UI 框架 | **Preact + Signals** | 扩展 UI 体积敏感。Preact 3kb，Signals 比 React Context 重渲染可控。Options/Popup/Content 注入 UI 都用它。 |
| 状态管理 | **@preact/signals-core** | 全局配置、翻译进度用 signal；持久化层订阅 signal 写 storage。比 Zustand 轻。 |
| 跨浏览器 API | **webextension-polyfill** | Promise 化 `chrome.*`，Firefox/Chrome 统一。WXT 内置集成。 |
| 内容解析 | **原生 DOM + linkedom（SSR 解析兜底）** | content script 用原生 DOM；PDF/复杂结构场景 linkedom 兜底。 |
| DB | **IndexedDB via idb** | idb 封装事务。缓存原文 hash→译文。 |
| 加密 | **Web Crypto API** | 密钥本地加密存储（见第 7 节）。 |
| 测试 | **Vitest（单测）+ Playwright（e2e）** | Vitest 跑协议/分批/并发算法纯函数；Playwright 跑真实页面翻译流程。 |
| token 预估 | **gpt-tokenizer** + 字符比例 fallback（中文 1.5 tok/char，英文 0.25 tok/char，保守取大） | 分批前预估，避免超 context window。 |
| LLM SDK | **不引 SDK，原生 fetch** | 扩展 fetch 即可，SDK 体积大且常引 Node 依赖。引擎适配层统一封装。 |

## 2. 整体架构

### 2.1 进程边界（MV3）

```
┌─────────────────────────────────────────────────────────┐
│  Content Script (每个页面一个, 有 DOM)                    │
│  - DOM 提取器: 找可翻译段落                              │
│  - 渲染器: 注入双语对照                                  │
│  - 注入控制条 UI (Preact)                                │
│  - 段落状态映射 (paragraphId → 原文/译文 DOM 引用)        │
└──────────────────────┬──────────────────────────────────┘
                       │ Port 长连接 (per-tab)
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Service Worker / Background (无 DOM, 可被卸载)           │
│  - 翻译调度核心 (批量打包器 + 并发控制器)                 │
│  - 引擎适配层 (OpenAI/Claude/Gemini/DeepSeek/Ollama)     │
│  - 缓存读写 (IndexedDB, SW 可访问)                       │
│  - 智能体提示词层                                        │
│  - 队列持久化 (chrome.storage.local) + chrome.alarms 恢复│
│  - 429 退避 + Retry-After                               │
└──────────────────────┬──────────────────────────────────┘
                       │ chrome.storage / chrome.runtime
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Options Page (独立页, Preact)                           │
│  - 引擎配置 / API Key 管理 / 加密存储                     │
│  - 提示词模板 / 术语库编辑器                              │
│  - 并发/分批参数 / 缓存管理                              │
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│  Popup (工具栏, Preact)                                  │
│  - 当前页翻译开关 / 进度 / 快速切引擎 / 模式             │
└─────────────────────────────────────────────────────────┘
```

### 2.2 通信协议

两种通道，按场景分：

1. **一次性消息 `chrome.runtime.sendMessage`**：低频、无状态命令。
   - popup → SW：`{type:"GET_STATUS", tabId}`、`{type:"TOGGLE_TRANSLATE", tabId, on}`、`{type:"SWITCH_ENGINE", engineId}`
   - options → SW：`{type:"CONFIG_CHANGED"}`（SW 重载配置）

2. **Port 长连接 `chrome.runtime.connect`**：高频、流式、双向。**翻译任务主通道**。
   - content → SW：`connect({name:"translate:<tabId>"})`
   - content → SW（postMessage on port）：`{type:"TRANSLATE_BATCH", items:[{id, text}]}`、`{type:"CANCEL"}`
   - SW → content：`{type:"PROGRESS", id, status}`、`{type:"RESULT", id, translated}`、`{type:"ERROR", id, reason}`、`{type:"BATCH_DONE", batchId}`
   - 流式（可选 P1）：SW → content `STREAM_CHUNK`

消息契约集中定义在 `src/shared/messages.ts`，TS discriminated union，两端共享类型。

### 2.3 为什么翻译核心放 Service Worker

- content script 每页面一份，并发请求若在页面侧发 = N 页面 × N 段落爆炸；SW 全局唯一，集中调度 = 真正全局并发上限。
- SW 跨页面共享缓存与队列。
- content script 只管 DOM 与渲染，职责单一，页面刷新不丢翻译调度（SW 持久化队列）。

## 3. 模块划分（目录结构）

```
src/
├── manifest.ts                    # WXT manifest 定义
├── entrypoints/
│   ├── background.ts              # SW 入口: 初始化调度器/缓存/恢复队列
│   ├── content.ts                 # content script 入口: 启动提取+渲染
│   ├── options/                   # options page (Preact)
│   └── popup/                     # popup (Preact)
├── shared/
│   ├── messages.ts                # 消息契约 (discriminated union)
│   ├── constants.ts               # 引擎列表/默认参数
│   └── types.ts                   # 共享类型 (Paragraph, Batch, Engine config)
├── background/
│   ├── orchestrator.ts            # ★ 翻译编排器: 收任务→查缓存→打包→调度→回传
│   ├── batcher/
│   │   ├── token-estimator.ts     # ★ token 预估 (gpt-tokenizer + fallback)
│   │   ├── packer.ts              # ★ 分批打包器: 按预算切批
│   │   └── protocol.ts            # ★ 批量协议: 组 prompt / 解析响应
│   ├── scheduler/
│   │   ├── concurrency-controller.ts  # ★ 有界并发 + 令牌桶
│   │   ├── retry.ts               # ★ 退避: 429/5xx + Retry-After
│   │   └── queue.ts               # 持久化队列 (storage.local + alarms)
│   ├── cache/
│   │   ├── cache-store.ts         # ★ IndexedDB 读写 (idb)
│   │   └── cache-key.ts           # hash 算法 (原文+引擎+提示词指纹)
│   ├── engines/
│   │   ├── adapter.ts             # ★ 引擎适配统一接口
│   │   ├── openai.ts              # OpenAI 兼容 (含 DeepSeek/通用 endpoint)
│   │   ├── anthropic.ts           # Claude
│   │   ├── gemini.ts              # Gemini
│   │   ├── ollama.ts              # 本地 Ollama
│   │   └── builtin.ts             # 兜底: Google/DeepL 免费翻译 API (可选)
│   ├── agent/
│   │   ├── prompt-builder.ts      # ★ 智能体提示词层: 系统提示词/角色/术语库
│   │   ├── glossary.ts            # 术语库匹配与注入
│   │   └── style-presets.ts       # 风格预设 (文学/技术/口语)
│   ├── config/
│   │   ├── config-store.ts        # 配置读写 (storage.local)
│   │   └── secret-store.ts        # ★ 加密密钥存储 (Web Crypto)
│   └── recovery.ts                # ★ alarms 恢复未完成队列
├── content/
│   ├── extractor/
│   │   ├── dom-walker.ts          # ★ DOM 提取: 找可翻译节点
│   │   ├── block-classifier.ts    # 段落分类 (正文/导航/代码/不译)
│   │   └── text-segmenter.ts      # 节点内文本切分 (按句/按节点)
│   ├── renderer/
│   │   ├── bilingual-renderer.ts  # ★ 双语对照渲染: 注入译文节点
│   │   ├── inline-markup.ts       # ★ 内联标记保护 (a/strong/code 占位符)
│   │   └── layout-guard.ts        # 防排版破坏: 监听 resize/回填
│   ├── controller.ts              # content 侧编排: 提取→发任务→渲染
│   ├── paragraph-registry.ts      # paragraphId ↔ DOM 映射
│   └── floating-ui/               # 控制条 Preact 组件
├── options/
├── popup/
└── tests/
```

模块边界（★=核心差异化）：

| 模块 | 职责 | 对外接口 | 依赖 |
|---|---|---|---|
| DOM 提取器 | 找可译段落，分类，分配 paragraphId | `extract(root): Paragraph[]` | 无 |
| 批量打包器 | 段落按 token 预算切批 | `pack(items, budget): Batch[]` | token-estimator |
| 批量协议 | 组 prompt/解析响应/校验对齐 | `buildPrompt(batch)`, `parseResponse(raw, batch)` | agent |
| 并发调度器 | 有界并发 + 令牌桶 + 退避 | `run(tasks, opts)` | retry |
| 缓存层 | hash 查存 | `get(key)`, `set(key,val)` | idb |
| 引擎适配层 | 统一 `translate(req): resp` | `Engine` 接口 | secret-store |
| 智能体提示词层 | 系统/角色/术语/风格 | `buildSystemPrompt(ctx)` | glossary |
| 渲染层 | 注入双语节点 | `render(paragraph, translated)` | inline-markup |

## 4. 批量翻译协议设计（核心差异化）

### 4.1 协议目标

一次请求翻 N 段，LLM 稳定返回**一一对应**的结构化译文，可校验、可定位失败段、不重翻整批。

### 4.2 输入输出 JSON 结构

请求给 LLM 的 user message（JSON 数组，每项带稳定 id）：

```json
{
  "items": [
    {"id": "1", "text": "The quick brown fox."},
    {"id": "2", "text": "It jumps over the lazy dog."}
  ]
}
```

期望响应（严格 JSON，id 与输入一致，顺序无关，靠 id 对齐）：

```json
{
  "items": [
    {"id": "1", "text": "敏捷的棕色狐狸。"},
    {"id": "2", "text": "它跳过了懒狗。"}
  ]
}
```

### 4.3 Prompt 模板

**System prompt（基础模式）**：

```
You are a professional translator. Translate the user-provided text into {targetLang}.
Rules:
1. Output ONLY valid JSON, no markdown, no explanation.
2. Output schema: {"items":[{"id":string,"text":string}]}.
3. Keep every "id" from the input unchanged. Return exactly one translation per input id.
4. Preserve inline markup placeholders like [[0]], [[1]] verbatim — do not translate, reorder, or delete them.
5. Do not merge or split items. One input id → one output id.
6. If an item is code/URL/untranslatable, return it unchanged in "text".
```

**System prompt（智能体/专家模式，叠加）**：

```
{roleContext}  // 角色: "You are a senior {domain} translator..."
Style: {stylePreset}  // 文学/技术/口语
Glossary (must follow, source→target):
- GPU → 图形处理器
- inference → 推理
Context: {pageContext}  // 页面标题/前段摘要, 上下文感知
Maintain terminology consistency across all items.
```

**User message**：上面 4.2 的 JSON。

### 4.4 强制结构化（双保险）

1. **JSON mode / structured output**：OpenAI `response_format:{type:"json_object"}`、Gemini `responseMimeType:"application/json"`、Claude 用 tool use 或 `<json>` 包裹约定。适配层按引擎开启。
2. **解析容错**：`parseResponse` 链路：
   - 先 `JSON.parse`；
   - 失败则正则提取 `{...}`/`<json>...</json>` 再 parse；
   - 仍失败 → 标记整批 parse error，走降级（见 4.6）。

### 4.5 分批算法（token 预估）

```ts
// pseudo
function pack(items: Item[], budget: TokenBudget): Batch[] {
  const batches: Batch[] = [];
  let cur: Item[] = [], curTokens = overheadTokens(systemPrompt);
  for (const it of items) {
    const t = estimateTokens(it.text);
    if (curTokens + t > budget.inputMax && cur.length) {
      batches.push(flush(cur)); cur = []; curTokens = overhead;
    }
    // 单段就超预算 → 再切 (按句)
    if (t > budget.inputMax) {
      for (const sub of splitBySentence(it, budget.inputMax * 0.8)) cur.push(sub);
    } else {
      cur.push(it); curTokens += t;
    }
    if (curTokens >= budget.inputMax * 0.9) { batches.push(flush(cur)); cur=[]; curTokens=overhead; }
  }
  if (cur.length) batches.push(flush(cur));
  // 数量上限 (避免单批太多 id 对齐失败时重试代价大)
  return batches.map(b => capByCount(b, MAX_ITEMS_PER_BATCH=20));
}
```

预算来源：引擎元数据 `contextWindow`、`maxOutput`，留 prompt overhead + output 余量（输入≤70%窗口，输出预留 maxOutput）。`estimateTokens`：OpenAI 系用 gpt-tokenizer；其余用字符比例（中文 1.5 tok/char，英文 0.25 tok/char，保守取大）。

### 4.6 失败重试与部分成功处理

**关键：失败定位到段，不重翻整批。**

逐级降级链：

1. **整批成功**：解析对齐全部 id → 直接回填。
2. **部分对齐**（如 20 段返回 18 段，缺 2 个 id）：
   - 已对齐的 18 段立即回填缓存。
   - 缺失段进入「重译队列」，**单独成批**重发（1 段一批），避免再触发对齐失败。
3. **整批 parse 失败 / 网络错 / 429**：
   - 429/5xx：整批入退避队列（见第 5 节），重试。
   - parse 失败：降级策略——把该批拆成更小批（如 20→4×5），降低对齐难度；再失败→逐段单发（回退到沉浸式行为但仅在容错路径）。
4. **单段仍失败 N 次**：标记该段为「翻译失败」，UI 显示原位错误占位，不阻塞其他段。

**幂等与缓存写入**：每段成功即写缓存（key=hash(原文+引擎+提示词指纹)）。重试只重缺的，已缓存的段跨重试不重翻。

## 5. 并发控制设计

### 5.1 有界并发 + 令牌桶

```ts
class ConcurrencyController {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private maxConcurrent: number,
              private rps: number,          // 每秒请求数上限
              private tpsBurst: number) {}  // token/秒突发上限
  async acquire(cost: number) {
    await this.gate();           // 并发槽
    await this.tokenBucket(cost); // 令牌桶 (RPS / TPM)
  }
  release(cost: number) { this.active--; this.drain(); this.refund(cost); }
}
```

- **maxConcurrent**：默认 3（可配 1–10）。全局唯一在 SW，真正全局限流。
- **令牌桶 RPS**：默认 2 req/s（防 429）。
- **令牌桶 TPM**（token/min）：按用户填的额度配，默认不启用，仅在用户开启「额度保护」时算 cost=批 token 量。

### 5.2 退避策略

```ts
function backoff(attempt, headers): delay {
  if (status === 429) {
    const ra = headers.get('retry-after');
    const raMs = ra ? (isNumeric(ra) ? +ra*1000 : Date.parse(ra)-Date.now()) : 0;
    return Math.max(raMs, exponentialDelay(attempt));  // 尊重 Retry-After, 取大
  }
  if (status >= 500) return exponentialDelay(attempt); // 1s,2s,4s,8s, cap 60s
  if (status === 408 || status === 0 /*网络*/) return exponentialDelay(attempt);
  return -1; // 4xx (非429) 不重试, 直接失败
}
```

- 最大重试 5 次，指数退避 `min(1000 * 2^n, 60000)` + ±20% jitter。
- 429 后**全局降速**：令牌桶 RPS 临时减半，连续成功 N 次后恢复（AIMD 思路）。
- 429 若带 `retry-after` 严格等待。

### 5.3 配置项（options 可调）

| 项 | 默认 | 说明 |
|---|---|---|
| `maxConcurrent` | 3 | 全局并发 |
| `rps` | 2 | 每秒请求数 |
| `tpmLimit` | 0（关） | 启用时按 token 限速 |
| `maxRetries` | 5 | 单批重试上限 |
| `itemsPerBatch` | 20 | 单批段数上限 |
| `batchTokenBudgetRatio` | 0.7 | 输入占窗口比例 |

## 6. 数据模型

### 6.1 IndexedDB schema（缓存）

DB: `batchtranslate-cache`，stores：

```
store: translations
  key: cacheKey  (sha256(sourceText + engineId + promptFingerprint + targetLang))
  value: {
    cacheKey: string
    source: string
    translated: string
    engineId: string
    promptFingerprint: string
    targetLang: string
    createdAt: number
    hitCount: number
    sourceUrl?: string      // 可选, 仅本地显示, 不外传
  }
  indexes: [createdAt], [engineId]

store: glossaries
  key: glossaryId
  value: { id, name, pairs:[{src,tgt}], enabled }

store: meta
  key: "stats" -> { requestCount, tokenUsed, cacheHits }
```

- 缓存 TTL 可配（默认永久，用户可清）。
- LRU 淘汰：超过容量上限按 createdAt 淘汰（默认上限 100MB，可调）。

### 6.2 chrome.storage schema

`storage.local`：

```
config:
  version: number
  engines: {
    [engineId]: {
      id, label, provider: "openai"|"anthropic"|"gemini"|"ollama"|"openai-compatible",
      baseUrl, model, enabled,
      apiKeyRef: string   // ★ 不存明文 key, 存 secret-store 的引用 id
      contextWindow, maxOutput
    }
  }
  activeEngineId: string
  targetLang: string
  sourceLang: "auto" | string
  mode: "basic" | "agent"
  agent: {
    systemPrompt: string        // 用户自定义, 覆盖默认
    role: string
    stylePreset: "literary"|"technical"|"casual"|"none"
    glossaryIds: string[]
    pageContextEnabled: boolean
  }
  scheduling: { maxConcurrent, rps, tpmLimit, maxRetries, itemsPerBatch, batchTokenBudgetRatio }
  cache: { enabled, maxSizeMB, ttlDays }
  queue: { [batchId]: BatchState }   // ★ 持久化队列, 供 alarms 恢复
  ui: { showOriginal, translationStyle, hoverOnly }
```

`storage.session`（SW 内存级，不持久）：运行中的批次临时状态。

`storage.sync`（可选）：非敏感 UI 偏好跨设备同步。**API Key 绝不进 sync**（会云同步，隐私风险）。

## 7. 隐私设计

### 7.1 纯本地，无遥测

- 翻译原文/译文**仅**在本地 SW ↔ 用户填的 LLM endpoint 之间流动，不经过任何本项目服务器。无后端。
- 零遥测：不集成 GA/PostHog/Sentry。崩溃日志本地存 IndexedDB，用户可导出。
- 缓存纯本地 IndexedDB，**绝不**生成分享链接（沉浸式泄露根因 = 结果存公开链接被搜索引擎抓取）。本项目无此功能，从根上杜绝。

### 7.2 密钥存储安全

`chrome.storage.local` 风险：扩展商店其他扩展理论上若获 host 权限可读、开发者模式本地文件可读、明文易随 profile 备份泄露。

对策：

1. **加密存储**：API Key 用 Web Crypto `AES-GCM` 加密后存 storage.local。
2. **主密钥来源**（二选一，P0 用 a，P1 升级 b）：
   - a. `crypto.getRandomValues` 生成 256-bit 主密钥，存 `storage.local`（仅混淆，挡不住本地攻击者，但挡爬虫/同步泄露）。
   - b. **更安全**：主密钥要求用户密码 PBKDF2 派生，密码不存；SW 启动需用户在 popup 输入解锁（解锁态存 `storage.session`，SW 卸载即失密）。P1 实现。
3. **`secret-store` 接口**：`setSecret(ref,plaintext)`、`getSecret(ref)` 内部加解密，引擎适配层只拿明文内存用，不落盘。
4. **`"permissions"` 最小化**：不申请 `<all_urls>` 之外多余权限；host 权限按用户启用范围动态申请（`optional_host_permissions`）。
5. **CSP**：manifest `content_security_policy` 禁远程代码，`connect-src` 仅用户配置的 endpoint。
6. **Ollama 本地模式**：完全离线，零外部请求，最高隐私档。

### 7.3 LLM 请求透明

- 控制条显示「正在发送至 {engineLabel} ({baseUrl})」，用户可见数据去向。
- 用户可勾选「不发送页面 URL/title」（默认仅发段落文本，不发 URL）。

## 8. MVP vs 路线图

### P0（MVP，6–8 周）

- WXT 工程脚手架 + manifest + 三入口
- DOM 提取器（正文段落识别、排除 code/nav/script）
- 双语对照渲染器（不破坏排版）+ 内联标记占位符保护
- 批量打包器 + token 预估 + 批量协议（JSON）+ 部分成功容错
- 并发控制器 + 令牌桶 + 429 退避
- 引擎适配：OpenAI 兼容（含 DeepSeek/通用）+ Claude + Gemini + Ollama
- 配置页（引擎/key/目标语言/并发参数）+ Popup（开关/进度/切引擎）
- 加密密钥存储（方案 a）
- IndexedDB 缓存 + LRU
- 队列持久化 + alarms 恢复
- Vitest 纯函数测试 + Playwright 基础 e2e

### P1（差异化深化，+4–6 周）

- 智能体模式：自定义系统提示词、角色、风格预设、术语库
- 页面上下文感知（标题/前段摘要注入）
- 流式渲染（SW→content stream chunk，边出边显示）
- 密钥主密码派生方案 b
- 翻译质量回退：智能体失败自动降级基础模式
- 手动重译/编辑译文/回写缓存
- 快捷键、按域名开关、翻译白名单

### P2（多场景，路线图）

- PDF（pdf.js 渲染 + 文本层翻译）
- 视频字幕（YouTube/B站，拦截字幕 track 或 OCR）
- 漫画/图片 OCR（Tesseract.js 本地 OCR → 翻译 → 文字层叠加）
- 鼠标悬停段落翻译（hover 模式）
- Epub/全文导出双语
- Firefox 正式发布（P0 即兼容，P2 正式测试）

## 9. 关键风险与对策

| 风险 | 对策 |
|---|---|
| **SW 被卸载导致翻译中断** | 队列状态写 `storage.local`；`chrome.alarms` 每 30s 检查恢复未完成批次；content script 重连时 SW 重建上下文（靠 batchId/paragraphId 幂等续传，缓存已存段不重翻）。 |
| **批量 JSON 对齐失败** | 4.6 降级链：部分对齐→缺段单独重发；整批 parse 失败→拆小批→逐段。绝不静默丢段。 |
| **token 预估不准超窗口** | 预算取 70% + 输出预留；预估用保守字符比例；超限单段按句切；引擎返回 context length error 自动缩批重试。 |
| **429 限流** | 全局唯一 SW 限流 + Retry-After + AIMD 降速；默认 RPS=2 保守起步。 |
| **不同引擎 JSON 能力差异**（Ollama 小模型易出格式错误） | 适配层按引擎选最强约束（JSON schema/tool use）；小模型启用「逐段模式」自动降级（batch=1）。 |
| **内联标签回填错位** | 占位符协议 `[[n]]`，prompt 强约束 verbatim；回填时按占位符重建 DOM，校验数量一致。 |
| **排版破坏（flex/grid/表格）** | 渲染器用 wrapper 节点隔离译文，不改动原节点属性；`layout-guard` 监听 MutationObserver 防页面 JS 重排覆盖译文；CSS 用 `display:block` 容器隔离。 |
| **SPA 页面动态加载新段落** | MutationObserver 监听 body 子树新增节点 → 提取增量段落入队；段落去重靠 paragraphId/原文 hash。 |
| **密钥泄露** | 见第 7 节加密 + 主密钥方案；P1 升级主密码派生。 |
| **缓存膨胀** | LRU + 容量上限 + 用户一键清；翻译前先查缓存（含同段跨页面命中）。 |
| **Firefox 兼容** | WXT + webextension-polyfill 统一；`browser_action`/`action` 差异 WXT 处理；MV3 在 Firefox 用 MV2 fallback。 |
| **CSP 阻止 fetch 到用户 endpoint** | manifest `host_permissions` 动态申请用户配置的 baseUrl；MV3 下扩展 fetch 不受页面 CSP 限制。 |
