import { defineConfig } from 'vitest/config';

// 配置/密钥层纯逻辑 + content/UI 组件统一 jsdom（组件测试需要 DOM）。
// .tsx 的 JSX 走 vitest(vite) 的 esbuild 转换（automatic runtime + preact），不引
// @preact/preset-vite（其依赖的 vite 版本与 vitest 内置 vite 冲突，会导致 .tsx 不被收集）。
// fake-indexeddb 在 jsdom 环境注入全局 indexedDB / IDBKeyRange,供 idb 使用。
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
  test: {
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
