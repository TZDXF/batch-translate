import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright e2e 配置（架构：Vitest 单测 + Playwright e2e）。
 *
 * 加载 `pnpm build` 产出的 `.output/chrome-mv3` 真实扩展，用持久化 context 启动 Chromium
 * （MV3 扩展只能以 persistent context 加载）。e2e mock LLM endpoint 用本地 mock server，
 * 不依赖真实 API Key（任务约束：覆盖率优先验证差异化点）。
 *
 * 运行：先 `pnpm build` 产出 .output/chrome-mv3，再 `pnpm e2e`。
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false, // 同一扩展 profile 共享 storage/IDB，串行避免状态串扰
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
    },
  ],
});
