import { test } from '@playwright/test';

/**
 * 扩展 e2e 冒烟（Stage 1 占位，先 skip）。
 *
 * 启用步骤（后续 issue）：
 * 1. `pnpm build` 产出 .output/chrome-mv3。
 * 2. 用 chromium 持久化上下文加载扩展：
 *    const pathToExtension = '.output/chrome-mv3';
 *    const ctx = await chromium.launchPersistentContext('', {
 *      headless: false,
 *      args: [
 *        `--disable-extensions-except=${pathToExtension}`,
 *        `--load-extension=${pathToExtension}`,
 *      ],
 *    });
 * 3. 打开 options/popup 页或任意网页，断言 content script 注入与双语渲染。
 *
 * 参考：https://playwright.dev/docs/chrome-extensions
 */
test.describe('BatchTranslate 扩展 e2e（占位）', () => {
  test.skip('扩展构建产物可加载', () => {
    // 见文件顶部注释。Stage 1 先 skip，避免 CI/本地无构建产物时报错。
  });
});
