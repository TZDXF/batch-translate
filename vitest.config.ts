import { defineConfig } from 'vitest/config';

// Vitest 配置。仅采集 src 下的单测；e2e（@playwright/test）由 playwright 独立运行，不在此采集。
export default defineConfig({
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.output/**', '.wxt/**'],
    environment: 'node',
  },
});
