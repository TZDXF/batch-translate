import { describe, expect, it } from 'vitest';
import { DEFAULT_MODE, DEFAULT_SOURCE_LANG, DEFAULT_TARGET_LANG } from '../shared/constants';

/**
 * 工程冒烟测试。目的：验证 vitest 基座、TS 编译与 src 模块解析链路通畅。
 * 真正的业务单测（协议解析 / 分批 / 并发算法等）在后续 issue 补充。
 */
describe('工程冒烟测试', () => {
  it('vitest 基本断言可用', () => {
    expect(1 + 1).toBe(2);
  });

  it('默认目标语言为简体中文', () => {
    expect(DEFAULT_TARGET_LANG).toBe('zh-CN');
  });

  it('默认源语言为自动检测', () => {
    expect(DEFAULT_SOURCE_LANG).toBe('auto');
  });

  it('默认翻译模式为基础模式', () => {
    expect(DEFAULT_MODE).toBe('basic');
  });
});
