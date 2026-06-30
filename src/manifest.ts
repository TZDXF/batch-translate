/**
 * MV3 manifest 非入口字段（单一事实来源）。
 * 对齐 docs/ARCHITECTURE.md 第 3、7.2.5 节。
 *
 * 入口驱动的字段（background.service_worker、action/popup、options_ui、content_scripts）
 * 由 WXT 按 src/entrypoints/* 自动生成并与本对象深合并，故此处不重复声明。
 *
 * 类型用宽松 Record 避免耦合 WXT 版本特定的 manifest 类型导出；wxt.config.ts 会将其
 * 作为 user manifest 合并进最终 manifest，字段名遵循 MV3 规范。
 */
const manifest = {
  manifest_version: 3,
  name: 'BatchTranslate',
  version: '0.1.0',
  description: '浏览器 AI 双语对照翻译扩展：批量合并降并发 + 自带 Key 任意 LLM + 本地缓存 + 纯本地隐私',

  // ── 权限（架构 7.2.4 最小化） ──────────────────────────────────────────
  permissions: ['storage', 'activeTab', 'scripting', 'alarms'],
  // host 权限按用户启用范围动态申请（架构 7.2.4 / 9）。先空数组，引擎 baseUrl 在
  // options 保存时由 background 动态请求 optional host permission。
  // 留空：不在安装期索要任意域权限，最大化隐私与商店审核友好度。
  host_permissions: [],
  optional_host_permissions: [],
  // content script 通过 WXT entrypoints/content.ts 声明 all_urls 匹配；
  // 实际 host 在用户启用翻译时按域动态申请。

  // ── CSP（架构 7.2.5：禁远程代码） ──────────────────────────────────────
  // 扩展页（options/popup）禁远程脚本；connect-src 放开用户配置的引擎 endpoint
  // （含本地 Ollama 的 http://localhost），fetch 真正受 host_permissions 约束。
  content_security_policy: {
    extension_pages: "script-src 'self'; object-src 'self'; connect-src 'self' https: http: ws:;",
  },

  // ── UI 图标占位（WXT 会在 public/ 放图标后自动补全） ───────────────────
  action: {
    default_title: 'BatchTranslate',
  },
} satisfies Record<string, unknown>;

export default manifest;
