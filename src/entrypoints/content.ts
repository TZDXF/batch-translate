/**
 * content script 入口（架构 3 节）：注入悬浮控制条、驱动 content 侧翻译编排。
 * matches <all_urls>，document_idle 注入；实际 host 权限由用户启用翻译时按域动态申请。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountControlBar, updateControlBar } from '../content/floating-ui/mount';
import { activeEngine, engineLabel, loadConfig } from '../background/config/config-store';
import { isToggleTranslate } from '../shared/messages';
import { isTranslating, startTranslation, stopTranslation, toggleTranslation } from '../content/controller';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    const cfg = await loadConfig();
    const eng = activeEngine(cfg);
    mountControlBar(
      { engineLabel: engineLabel(eng), baseUrl: eng?.baseUrl ?? '' },
      () => {
        void toggleTranslation();
      },
    );

    // popup 开关 → SW → 中继 TOGGLE_TRANSLATE 到本 tab → 驱动 content 控制器（架构 2.2）。
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isToggleTranslate(msg)) return;
      if (msg.on) {
        updateControlBar({ on: true });
        if (!isTranslating()) void toggleTranslation();
      } else {
        void stopTranslation();
      }
    });
  },
});
