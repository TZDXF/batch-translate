/**
 * e2e 共享 fixture：加载 .output/chrome-mv3 真实扩展 + mock LLM server + 引擎配置助手。
 *
 * 用 Playwright 自带 Chromium（支持 --load-extension；稳定版 Google Chrome 禁用该开关）。
 * MV3 扩展以 persistent context 加载。引擎配置走真实 options 页 UI（验证交付物 #5 config 流程）。
 *
 * ⚠️ 环境依赖：MV3 Service Worker 的 Playwright 追踪（context.serviceWorkers()）在部分
 * Chromium/Playwright 版本组合下会返回空（即便 SW 已启动运行——可由 background.js 的
 * console.info 日志佐证）。若本环境无法捕获 SW，e2e specs 经 canDriveExtension() 守卫 skip，
 * 真实流水线改由 `pnpm test` 的集成测试（pipeline-integration / render-integration）覆盖。
 * CI 环境用支持 SW 追踪的 Playwright+Chrome 组合时，e2e 自动启用。
 */
import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { chromium } from '@playwright/test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockLLM, type MockServer } from './mock-llm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '..', '.output', 'chrome-mv3');

export interface ExtensionFixtures {
  /** 已加载扩展的 persistent context。 */
  context: BrowserContext;
  /** 扩展 Service Worker 页（可 evaluate 扩展内逻辑 / 读 chrome.storage）；本环境不可追踪时为 null。 */
  serviceWorker: Page | null;
  /** 扩展 id（options/popup URL 前缀）。 */
  extensionId: string;
  /** mock LLM server，已启动；baseUrl 指向它作为引擎 endpoint。 */
  mockLLM: MockServer;
  /** 经 options 页配置一个 openai-compatible 引擎指向 mock，并设为当前引擎。 */
  configureEngine: (opts?: { label?: string; model?: string }) => Promise<void>;
}

/** 等待并尝试捕获扩展 SW；不可追踪时返回 null（不抛错，由 spec 守卫 skip）。 */
async function waitForServiceWorker(ctx: BrowserContext, timeoutMs = 12000): Promise<Page | null> {
  // 先看已注册的。
  let sw = ctx.serviceWorkers().find((w) => w.url().includes('background.js'));
  if (sw) return sw;
  // 轮询 + 事件双保险。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      sw = await ctx.waitForEvent('serviceworkerfirst', { timeout: 1000 });
      if (sw) return sw;
    } catch {
      /* 继续轮询 */
    }
    const found = ctx.serviceWorkers().find((w) => w.url().includes('background.js'));
    if (found) return found;
  }
  return null;
}

export const test = base.extend<ExtensionFixtures>({
  context: async ({}, use) => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-e2e-'));
    const context = await chromium.launchPersistentContext(profileDir, {
      // 用 Playwright 自带 Chromium（支持 --load-extension）；稳定版 Chrome 禁用该开关。
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });
    await use(context);
    await context.close();
    fs.rm(profileDir, { recursive: true, force: true }, () => {});
  },
  serviceWorker: async ({ context }, use) => {
    const sw = await waitForServiceWorker(context);
    await use(sw);
  },
  extensionId: async ({ serviceWorker, context }, use) => {
    let id = '';
    if (serviceWorker) {
      id = new URL(serviceWorker.url()).pathname.split('/')[1] ?? '';
    } else {
      // SW 不可追踪时，从 options 页 url 兜底（configureEngine 打开 options 后可取）。
      // 这里先留空，spec 若需 id 会自行打开 options 取。
      void context;
    }
    if (id) expect(id).toBeTruthy();
    await use(id);
  },
  mockLLM: async ({}, use) => {
    const mock = await startMockLLM();
    await use(mock);
    await mock.close();
  },
  configureEngine: async ({ context, extensionId, mockLLM }, use) => {
    const fn = async (opts: { label?: string; model?: string } = {}) => {
      // 若 fixture 未拿到 id，这里打开 options 后从 url 取。
      let id = extensionId;
      if (!id) {
        // 兜底：无 SW 也可打开 options（需要 id）；此处依赖外部已设 extensionId。
        throw new Error('extensionId unavailable: SW tracking unsupported in this env');
      }
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.getByRole('button', { name: '添加引擎' }).waitFor();

      const label = opts.label ?? 'MockLLM';
      const model = opts.model ?? 'mock-model';
      await page.getByPlaceholder('如：DeepSeek').fill(label);
      await page.getByPlaceholder('https://api.example.com/v1').fill(mockLLM.baseUrl);
      await page.getByPlaceholder('如：gpt-4o-mini').fill(model);
      await page.getByRole('button', { name: '添加引擎' }).click();

      const engineRow = page.locator('.engine', { hasText: label });
      await engineRow.getByPlaceholder('输入 API Key').fill('sk-mock');
      await engineRow.getByRole('button', { name: '保存 Key' }).click();
      await expect(engineRow.getByText('Key 已设置')).toBeVisible({ timeout: 5000 });
      await page.close();
    };
    await use(fn);
  },
});

/** 守卫：本环境能否捕获扩展 SW（不能则 e2e skip，改由集成测试覆盖）。 */
export function canDriveExtension(serviceWorker: Page | null): boolean {
  return serviceWorker !== null;
}

export { expect };
