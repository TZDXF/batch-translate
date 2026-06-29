import { defineConfig } from 'wxt';
import manifest from './src/manifest';

// WXT 构建配置。详见 docs/ARCHITECTURE.md §1（技术栈）/ §3（目录结构）。
// - srcDir: 'src' → entrypoints 位于 src/entrypoints，与架构 §3 目录结构一致。
// - manifest: 由 src/manifest.ts 提供单一来源，WXT 运行时 defu 合并进最终 manifest.json。
// - Preact：不引 React，直接通过 esbuild 的 automatic JSX runtime + preact/jsx-runtime，
//   体积最小、无 react/compat 别名负担。
export default defineConfig({
  srcDir: 'src',
  manifest,
  vite: () => ({
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
  }),
});
