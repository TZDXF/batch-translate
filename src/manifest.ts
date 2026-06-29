import type { UserManifest } from 'wxt';

/**
 * Manifest 定义（MV3）。WXT 会把这里的字段与自动生成的 manifest（entrypoints / icons 等）
 * 通过 defu 深合并，写进 .output/<browser>-mv3/manifest.json。
 *
 * 说明：WXT 0.20 已移除旧的 `defineManifest`（`wxt/tools` 入口不再存在）；现代写法是
 * 在 wxt.config.ts 的 `manifest` 选项里提供一个对象/文件。本文件即为该对象的单一来源，
 * 由 wxt.config.ts 导入。WXT 的 UserManifest 类型刻意排除了 permissions 等键（交由自动
 * 检测管理），但运行时会合并 manifest 的任意字段，因此这里显式补回 permissions /
 * host_permissions / optional_host_permissions，并保留字段提示与类型安全。
 *
 * 权限最小化原则见隐私设计 §7.2：不申请 <all_urls> 之外多余权限；host 权限按用户配置的
 * 引擎 baseUrl 动态申请（chrome.permissions.request）。
 */
type AppManifest = UserManifest & {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

const manifest: AppManifest = {
  name: 'BatchTranslate',
  description: '浏览器 AI 双语对照翻译扩展',

  // 最小权限：仅本地存储与用户手势触发的 activeTab。
  // 翻译所需的 host 权限不在此静态申请，改为按需动态申请（见 optional_host_permissions）。
  permissions: ['storage', 'activeTab'],

  // 初始留空。用户在 Options 配置引擎 baseUrl 后，由 background 侧调用
  // chrome.permissions.request({ origins: [...] }) 按启用范围申请，例如：
  //   'https://api.openai.com/*'
  //   'https://api.anthropic.com/*'
  //   'https://generativelanguage.googleapis.com/*'
  //   'https://api.deepseek.com/*'
  //   'http://localhost:11434/*'   // Ollama 本地
  optional_host_permissions: [],
};

export default manifest;
