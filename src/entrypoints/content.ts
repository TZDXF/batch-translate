/**
 * content script 入口（架构 3 节）：注入悬浮控制条、驱动 content 侧翻译编排。
 * matches <all_urls>，document_idle 注入；实际 host 权限由用户启用翻译时按域动态申请。
 *
 * P1-3 交互增强：
 *  - 按域名策略（黑名单 / 白名单）决定是否允许翻译；禁用域名挂载禁用态控制条（验收：黑名单域名不自动翻译）。
 *  - 全局快捷键：开关翻译 / 循环显示模式 / 重译当前段（options 可自定义，默认见 DEFAULT_SHORTCUTS）。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountControlBar, updateControlBar } from '../content/floating-ui/mount';
import { activeEngine, engineLabel, loadConfig } from '../background/config/config-store';
import { isToggleTranslate } from '../shared/messages';
import {
  cycleDisplayMode,
  isTranslating,
  retranslateCurrent,
  stopTranslation,
  toggleTranslation,
} from '../content/controller';
import { isDomainAllowed, normalizeHostname } from '../content/domain-policy';
import { acceleratorsEqual, eventToAccelerator } from '../content/shortcuts';
import type { ShortcutAction } from '../shared/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  async main() {
    const cfg = await loadConfig();
    const eng = activeEngine(cfg);
    const host = normalizeHostname(location.hostname);
    const allowed = isDomainAllowed(host, cfg.domain);
    const blockedMsg = allowed
      ? null
      : cfg.domain.mode === 'whitelist'
        ? '当前域名不在翻译白名单内'
        : '当前域名在翻译黑名单内';

    mountControlBar(
      { engineLabel: engineLabel(eng), baseUrl: eng?.baseUrl ?? '', blocked: blockedMsg },
      () => {
        // 域名策略禁用时按钮 disabled，但仍兜底拦截。
        if (!allowed) return;
        void toggleTranslation();
      },
    );

    // popup 开关 → SW → 中继 TOGGLE_TRANSLATE 到本 tab → 驱动 content 控制器（架构 2.2）。
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isToggleTranslate(msg)) return;
      if (!allowed) return; // 黑名单域名忽略外部开关指令
      if (msg.on) {
        updateControlBar({ on: true });
        if (!isTranslating()) void toggleTranslation();
      } else {
        void stopTranslation();
      }
    });

    // 全局快捷键（P1-3）：在 document 上捕获，匹配当前配置的加速器。
    document.addEventListener('keydown', (e) => {
      const acc = eventToAccelerator(e);
      if (!acc) return;
      const map = cfg.shortcuts as Record<ShortcutAction, string>;
      let action: ShortcutAction | null = null;
      if (acceleratorsEqual(acc, map.toggle)) action = 'toggle';
      else if (acceleratorsEqual(acc, map.cycleDisplayMode)) action = 'cycleDisplayMode';
      else if (acceleratorsEqual(acc, map.retranslate)) action = 'retranslate';
      if (!action) return;
      // 快捷键触发时同样受域名策略约束。
      if (!allowed && action !== 'cycleDisplayMode') return;
      e.preventDefault();
      if (action === 'toggle') {
        void toggleTranslation();
      } else if (action === 'cycleDisplayMode') {
        void cycleDisplayMode();
      } else if (action === 'retranslate') {
        void retranslateCurrent();
      }
    });
  },
});
