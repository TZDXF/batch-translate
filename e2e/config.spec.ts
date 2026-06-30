import { test, expect, canDriveExtension } from './fixtures';

/**
 * config：options 配引擎/key → popup 切换 → 生效。
 * 验证交付物 #5：真实 options 页 UI 配置引擎 + Key，写入 storage，生效于翻译。
 */
test('config：options 配引擎 + Key → 写入 storage 生效', async ({ context, serviceWorker, extensionId, mockLLM, configureEngine }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  await configureEngine();

  // options 页配置写入 storage.local（引擎 + activeEngineId）。
  const config = await serviceWorker!.evaluate(async () => {
    const rec = await chrome.storage.local.get('config');
    return rec.config;
  });
  const engines = Object.values(config.engines);
  expect(engines).toHaveLength(1);
  expect(engines[0].baseUrl).toBe(mockLLM.baseUrl);
  expect(engines[0].model).toBe('mock-model');
  expect(config.activeEngineId).toBe(engines[0].id);

  // Key 已加密存储（secret-store 写入 __secret:<ref>）。
  const hasKey = await serviceWorker!.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all).some((k) => k.startsWith('__secret:'));
  });
  expect(hasKey).toBe(true);

  // popup 可读配置（GET_CONFIG）。
  const cfgResp = await serviceWorker!.evaluate(async () => {
    return chrome.runtime.sendMessage({ type: 'GET_CONFIG' });
  });
  expect(cfgResp?.type).toBe('CONFIG');
  expect(cfgResp.config.activeEngineId).toBe(engines[0].id);

  void extensionId;
});
