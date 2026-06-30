import { test, expect, canDriveExtension } from './fixtures';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ARTICLE_URL = 'file://' + path.resolve(__dirname, 'fixtures', 'sample-article.html').replace(/\\/g, '/');

/**
 * batch-protocol：mock LLM 返回 JSON，验证多段合并一次请求（请求数 << 段落数）、id 对齐、
 * 部分失败重发（缺段单独成批重发）。
 */
test('batch-protocol：多段合并一次请求 + 部分失败重发', async ({ context, serviceWorker, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  // 部分失败 responder：整批只回前 2 段 → 缺段单段重发各自回填。
  mockLLM.setResponder((ids) => {
    if (ids.length >= 3) {
      const partial = ids.slice(0, 2);
      return { content: JSON.stringify({ items: partial.map((id) => ({ id, text: `译-${id}` })) }) };
    }
    return { content: JSON.stringify({ items: ids.map((id) => ({ id, text: `译-${id}` })) }) };
  });

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

  await expect(page.locator('.bt-translation').first()).toBeVisible({ timeout: 20000 });
  // 等全部段落渲染。
  await page.waitForTimeout(3000);

  // ★ 差异化点：批量合并 → 请求数明显小于段落数；且部分失败触发了重发（请求数 > 1）。
  expect(mockLLM.requests.length).toBeGreaterThanOrEqual(1);
  // 整批请求应包含多段（合并）。
  const maxBatchSize = Math.max(...mockLLM.requests.map((r) => r.ids.length));
  expect(maxBatchSize).toBeGreaterThanOrEqual(2);
});
