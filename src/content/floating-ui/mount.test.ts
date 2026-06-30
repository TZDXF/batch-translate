import { describe, it, expect, beforeEach } from 'vitest';
import {
  __getControlBarStateForTests,
  __resetControlBarForTests,
  mountControlBar,
  updateControlBar,
} from './mount';

describe('floating-ui 控制条（Shadow DOM 隔离 + 透明化，架构 7.3）', () => {
  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body></body>';
    __resetControlBarForTests();
  });

  it('挂载到 Shadow DOM，渲染「翻译本页」与数据去向文案', () => {
    mountControlBar({ engineLabel: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' }, () => {});
    const host = document.getElementById('bt-control-host');
    expect(host).toBeTruthy();
    expect(host?.shadowRoot).toBeTruthy();
    const text = host?.shadowRoot?.textContent ?? '';
    expect(text).toContain('翻译本页');
    expect(text).toContain('DeepSeek');
    expect(text).toContain('https://api.deepseek.com/v1');
  });

  it('开关切换为翻译中后显示停止按钮 + 进度', () => {
    mountControlBar({ engineLabel: 'Ollama', baseUrl: 'http://localhost:11434' }, () => {});
    updateControlBar({ on: true, state: 'translating', progress: 0.5 });
    expect(__getControlBarStateForTests().on).toBe(true);
    const text = document.getElementById('bt-control-host')?.shadowRoot?.textContent ?? '';
    expect(text).toContain('停止翻译');
    expect(text).toContain('50%');
  });

  it('错误状态展示错误信息', () => {
    mountControlBar({ engineLabel: 'X', baseUrl: '' }, () => {});
    updateControlBar({ on: true, state: 'error', error: '429 限流' });
    const text = document.getElementById('bt-control-host')?.shadowRoot?.textContent ?? '';
    expect(text).toContain('429 限流');
  });

  it('挂载是幂等的（重复调用只更新不重复创建）', () => {
    mountControlBar({ engineLabel: 'A' }, () => {});
    mountControlBar({ engineLabel: 'B' }, () => {});
    const hosts = document.querySelectorAll('#bt-control-host');
    expect(hosts.length).toBe(1);
    expect(__getControlBarStateForTests().engineLabel).toBe('B');
  });
});
