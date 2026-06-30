import { test, expect, canDriveExtension } from './fixtures';

/**
 * smoke：验证扩展可加载、SW 可追踪（本环境前置）、options 页可配置引擎指向 mock。
 *
 * 若本环境 Playwright 无法追踪 MV3 SW（canDriveExtension === false），skip，
 * 真实流水线由集成测试 pipeline-integration / render-integration 覆盖。
 */
test('扩展加载 + SW 就绪 + options 配引擎', async ({ serviceWorker, extensionId, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip（流水线由集成测试覆盖）');

  expect(serviceWorker!.url()).toContain('background.js');
  expect(extensionId).toBeTruthy();

  await configureEngine();

  // 验证配置写入 storage.local。
  const config = await serviceWorker!.evaluate(async () => {
    const rec = await chrome.storage.local.get('config');
    return rec.config;
  });
  const engines = Object.values(config.engines);
  expect(engines.length).toBe(1);
  expect(engines[0].baseUrl).toBe(mockLLM.baseUrl);
  expect(config.activeEngineId).toBe(engines[0].id);
});
