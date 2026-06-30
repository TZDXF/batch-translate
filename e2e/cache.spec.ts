import { test, expect, canDriveExtension } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLE_URL = 'file://' + path.resolve(__dirname, 'fixtures', 'sample-article.html').replace(/\\/g, '/');

/**
 * cache：同页二次翻译命中缓存（请求数为 0）。
 * 核心契约：缓存命中段不发请求。
 */
test('cache：二次翻译命中缓存，请求数为 0', async ({ context, serviceWorker, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  await configureEngine();
  const page = await context.newPage();
  await page.goto(ARTICLE_URL);
  const tabId = await serviceWorker!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });

  // 第一次翻译：产生请求 + 写缓存。
  await serviceWorker!.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TRANSLATE', tabId: tid, on: true });
  }, tabId);
  await expect(page.locator('.bt-translation').first()).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(2000);
  const firstReqCount = mockLLM.requests.length;
  expect(firstReqCount).toBeGreaterThanOrEqual(1);

  // 关闭再开（重新翻译同页）。
  await serviceWorker!.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TRANSLATE', tabId: tid, on: false });
  }, tabId);
  await page.waitForTimeout(500);
  mockLLM.reset(); // 清计数
  await serviceWorker!.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TRANSLATE', tabId: tid, on: true });
  }, tabId);
  await page.waitForTimeout(2000);

  // ★ 二次翻译命中缓存：新增请求数为 0（或极少，取决于 cacheKey 一致性）。
  expect(mockLLM.requests.length).toBe(0);
});
