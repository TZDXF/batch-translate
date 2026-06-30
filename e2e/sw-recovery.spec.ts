import { test, canDriveExtension } from './fixtures';

/**
 * sw-recovery：翻译中途卸载 SW → 恢复续传。
 *
 * MV3 SW 卸载 + chrome.alarms 恢复 + 持久化队列幂等续传。
 * 完整 SW 生命周期模拟在 e2e 受限于 SW 追踪；持久化队列 + 恢复扫描的单元覆盖见
 * recovery.test.ts（38 项）。此处为 e2e 烟雾断言：alarm 已注册。
 */
test('sw-recovery：恢复 alarm 已注册', async ({ serviceWorker }) => {
  test.skip(!canDriveExtension(serviceWorker), '本环境无法追踪 MV3 SW，e2e skip');

  const hasAlarm = await serviceWorker!.evaluate(async () => {
    const alarms = await chrome.alarms.getAll();
    return alarms.some((a: { name: string }) => a.name === 'batchtranslate-recovery');
  });
  if (!hasAlarm) {
    // alarm 注册是异步的；再等一轮。
    await serviceWorker!.evaluate(() => new Promise((r) => setTimeout(r, 1000)));
  }
  const ok = await serviceWorker!.evaluate(async () => {
    const alarms = await chrome.alarms.getAll();
    return alarms.some((a: { name: string }) => a.name === 'batchtranslate-recovery');
  });
  if (!ok) throw new Error('recovery alarm not registered');
});
