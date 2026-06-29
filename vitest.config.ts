import { defineConfig } from 'vitest/config';

// 共享契约层（src/shared）为纯类型/常量/纯函数，node 环境即可。
// 后续 content/SW 模块需要 DOM 时再按需切换 environment。
// fake-indexeddb 在 Node 环境注入全局 indexedDB / IDBKeyRange,供 idb 使用。
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
  },
});
