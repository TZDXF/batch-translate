import { defineConfig } from 'vitest/config';

// 共享契约层（src/shared）为纯类型/常量/纯函数，node 环境即可。
// 后续 content/SW 模块需要 DOM 时再按需切换 environment。
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
