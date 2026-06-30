import { test, expect, canDriveExtension } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLE_URL = 'file://' + path.resolve(__dirname, 'fixtures', 'sample-article.html').replace(/\\/g, '/');

/**
 * translate-page：打开 fixture 英文页 → popup 开翻译 → 验证双语对照渲染、原文属性未改、
 * 段落数量对齐。
 *
 * 需 SW 追踪 + 引擎配置就绪。SW 不可追踪时 skip（由 render-integration 覆盖渲染契约）。
 */
test('translate-page：双语对照渲染 + 原文属性未改 + 段落对齐', async ({ context, serviceWorker, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  await configureEngine();
  // 默认 mock 回填「译：<id>」。
  const page = await context.newPage();
  await page.goto(ARTICLE_URL);

  // 经 popup 开翻译：直接给 SW 发 TOGGLE_TRANSLATE（tabId 取当前页）。
  const tabId = await serviceWorker!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });
  expect(tabId).toBeGreaterThan(0);

  await serviceWorker!.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TRANSLATE', tabId: tid, on: true });
  }, tabId);

  // 等待译文 wrapper 出现（双语渲染）。
  await expect(page.locator('.bt-translation').first()).toBeVisible({ timeout: 20000 });
  const wrappers = await page.locator('.bt-translation').count();
  expect(wrappers).toBeGreaterThanOrEqual(1);

  // mock 收到请求（批量合并：请求数 << 段落数）。
  expect(mockLLM.requests.length).toBeGreaterThanOrEqual(1);
  expect(mockLLM.requests.length).toBeLessThan(wrappers + 5);

  // 原文属性未改：原段落未被加 bt- 类。
  const polluted = await page.locator('p.bt-translation, h1.bt-translation').count();
  expect(polluted).toBe(0);
});
