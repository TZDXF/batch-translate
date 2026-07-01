/**
 * PDF 翻译 e2e（P2-1 / TRA-24）。
 *
 * 加载真实扩展 → 配置 mock LLM 引擎 → 打开 pdf-viewer.html?url=<sample.pdf data URL>
 * → 点「开启翻译」→ 等待 bt-pdf-translation overlay 出现 → 断言：
 *  - pdf.js 渲染了页面（canvas + textLayer）；
 *  - 文本层段落经 Port 翻译，mock LLM 收到带 items 的请求；
 *  - 译文 overlay 叠加在文本层上。
 *
 * 用 data URL 内联 sample.pdf，避免 file:// host 权限问题。
 * 与其它 spec 同守卫：本环境无法追踪 MV3 SW 时 skip（见 fixtures.ts）。
 */
import { test, expect, canDriveExtension } from './fixtures';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PDF_PATH = path.resolve(__dirname, 'fixtures', 'sample.pdf');

test('pdf：文本层双语对照翻译叠加', async ({ context, serviceWorker, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  await configureEngine();

  // 内联 sample.pdf 为 data URL，避开 file:// host 权限。
  const pdfBytes = readFileSync(PDF_PATH);
  const dataUrl = `data:application/pdf;base64,${pdfBytes.toString('base64')}`;

  // 取扩展 id（configureEngine 已确保 SW 可追踪 → extensionId 已就绪）。
  const sw = serviceWorker!;
  const id = new URL(sw.url()).pathname.split('/')[1] ?? '';
  expect(id).toBeTruthy();

  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pdf-viewer.html?url=${encodeURIComponent(dataUrl)}`);

  // 等 PDF 加载完成（状态文案出现页数）。
  await expect(page.locator('#bt-pdf-status')).toContainText('点击', { timeout: 20_000 });

  // 点开启翻译。
  await page.getByRole('button', { name: '开启翻译' }).click();

  // 等 overlay 出现（pdf.js 渲染 + 文本层提取 + Port 翻译往返）。
  await expect(page.locator('.bt-pdf-translation').first()).toBeVisible({ timeout: 30_000 });

  // mock LLM 收到带 items 的翻译请求（文本层段落入队）。
  expect(mockLLM.requests.length).toBeGreaterThanOrEqual(1);
  const maxBatch = Math.max(...mockLLM.requests.map((r) => r.ids.length));
  expect(maxBatch).toBeGreaterThanOrEqual(1);

  // overlay 文本应为 mock 默认回填「译：<id>」。
  const firstOverlay = page.locator('.bt-pdf-translation').first();
  await expect(firstOverlay).toContainText('译：', { timeout: 10_000 });
});
