import { test, expect, canDriveExtension } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLE_URL = 'file://' + path.resolve(__dirname, 'fixtures', 'sample-article.html').replace(/\\/g, '/');

/**
 * concurrency：多段时并发不超 maxConcurrent（mock 慢响应，断言在途峰值 ≤ 上限）。
 */
test('concurrency：在途并发不超 maxConcurrent', async ({ context, serviceWorker, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  // 慢响应让在途可观测。
  mockLLM.setResponder((ids) => ({ content: JSON.stringify({ items: ids.map((id) => ({ id, text: `译-${id}` })) }), delayMs: 300 }));

  await configureEngine();
  const page = await context.newPage();
  await page.goto(ARTICLE_URL);
  const tabId = await serviceWorker!.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0]?.id ?? -1;
  });
  await serviceWorker!.evaluate(async (tid) => {
    await chrome.runtime.sendMessage({ type: 'TOGGLE_TRANSLATE', tabId: tid, on: true });
  }, tabId);

  await expect(page.locator('.bt-translation').first()).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000);

  // ★ 并发控制在途 ≤ maxConcurrent（默认 3）。
  expect(mockLLM.peakInFlight).toBeLessThanOrEqual(3);
});
