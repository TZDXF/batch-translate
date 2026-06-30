import { defineConfig } from 'vitest/config';

// 共享契约层（src/shared）为纯类型/常量/纯函数；content 渲染层测试用 jsdom 提供 DOM。
// fake-indexeddb 在测试环境注入全局 indexedDB / IDBKeyRange,供 idb 使用（node 与 jsdom 均可）。
// e2e 走 Playwright（见架构第 1 节）。
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
