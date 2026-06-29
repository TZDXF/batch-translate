import { defineConfig } from 'wxt';
import manifest from './src/manifest';

// WXT 配置。架构第 1、3 节：MV3 + Preact + Signals，srcDir=src 以匹配 src/entrypoints 结构。
// Preact JSX 走 vite 内置 esbuild（automatic runtime + jsxImportSource=preact），不引
// @preact/preset-vite（其依赖的 vite 版本与 WXT 内置 vite 冲突）。
export default defineConfig({
  srcDir: 'src',
  // manifest 的非入口字段（权限/host/CSP）集中在 src/manifest.ts；
  // 入口驱动的部分（action/popup、options_ui、content_scripts、background）由 WXT 按
  // src/entrypoints/* 自动生成并与下方对象深合并。
  manifest,
  vite: () => ({
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    plugins: [
      // Windows + WXT 0.20 工具链兼容：内置 wxt:download 插件会把入口绝对路径（含盘符 `C:`）
      // 误当 `url:` 导入去 fetch，undici 视 `C:` 为未知 scheme 导致 build 失败并劫持入口模块。
      // 本项目无 `url:` 远程导入，故在 configResolved 把该插件钩子置空，让正常文件加载器接管。
      // （download 仅用于 `url:https://...` 远程导入打包，禁用不影响功能。）
      {
        name: 'bt-neutralize-download-plugin',
        enforce: 'pre',
        configResolved(resolved) {
          const dl = resolved.plugins.find((p) => p.name === 'wxt:download');
          if (dl) {
            (dl as { resolveId?: unknown }).resolveId = undefined;
            (dl as { load?: unknown }).load = undefined;
          }
        },
      },
    ],
  }),
});
