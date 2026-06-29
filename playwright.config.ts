import { defineConfig } from '@playwright/test';

/**
 * Playwright e2e 配置。
 *
 * 测试 MV3 扩展需用持久化上下文（persistent context）+ --load-extension，且需 headed 运行。
 * 当前 Stage 1 仅占位 spec（见 e2e/smoke.spec.ts，已 skip）；完整翻译流程 e2e 在后续 issue 启用。
 * 参考：https://playwright.dev/docs/chrome-extensions
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
});
