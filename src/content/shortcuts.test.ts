/** 快捷键映射测试（P1-3 纯函数：归一化 / 事件转换 / 冲突检测）。 */
import { describe, expect, it } from 'vitest';
import type { Shortcuts } from '../shared/types';
import { DEFAULT_SHORTCUTS } from '../shared/constants';
import {
  acceleratorsEqual,
  detectConflicts,
  eventToAccelerator,
  normalizeAccelerator,
  validateShortcut,
} from './shortcuts';

describe('normalizeAccelerator', () => {
  it('归一化修饰键顺序 + 主键大写', () => {
    expect(normalizeAccelerator('shift+alt+t')).toBe('Alt+Shift+T');
    expect(normalizeAccelerator('Ctrl+T')).toBe('Ctrl+T');
    expect(normalizeAccelerator('mod+r')).toBe('Mod+R');
  });
  it('接受 cmd / command 作为 Meta', () => {
    expect(normalizeAccelerator('cmd+k')).toBe('Meta+K');
    expect(normalizeAccelerator('command+k')).toBe('Meta+K');
  });
  it('非法：缺主键 / 多主键 / 非法主键 / Mod 与 Ctrl 混用', () => {
    expect(normalizeAccelerator('Ctrl+Shift')).toBeNull();
    expect(normalizeAccelerator('Ctrl+T+R')).toBeNull();
    expect(normalizeAccelerator('Ctrl+F1')).toBeNull(); // 仅单字符字母/数字
    expect(normalizeAccelerator('Mod+Ctrl+T')).toBeNull();
    expect(normalizeAccelerator('')).toBeNull();
  });
});

describe('eventToAccelerator', () => {
  it('从键盘事件构造加速器', () => {
    expect(eventToAccelerator({ key: 't', altKey: true, shiftKey: true })).toBe('Alt+Shift+T');
    expect(eventToAccelerator({ key: 'R', ctrlKey: true })).toBe('Ctrl+R');
  });
  it('纯修饰键按压返回 null', () => {
    expect(eventToAccelerator({ key: 'Shift', shiftKey: true })).toBeNull();
    expect(eventToAccelerator({ key: 'Control', ctrlKey: true })).toBeNull();
  });
  it('非单字符主键返回 null', () => {
    expect(eventToAccelerator({ key: 'F1', altKey: true })).toBeNull();
    expect(eventToAccelerator({ key: 'Enter' })).toBeNull();
  });
});

describe('acceleratorsEqual', () => {
  it('归一化后比较', () => {
    expect(acceleratorsEqual('shift+alt+t', 'Alt+Shift+T')).toBe(true);
    expect(acceleratorsEqual('Ctrl+T', 'Alt+T')).toBe(false);
    expect(acceleratorsEqual('Ctrl', 'Ctrl+T')).toBe(false);
  });
});

describe('detectConflicts / validateShortcut', () => {
  it('默认快捷键无冲突', () => {
    expect(detectConflicts({ ...DEFAULT_SHORTCUTS })).toEqual([]);
  });
  it('两个动作同加速器 → 冲突', () => {
    const s: Shortcuts = { toggle: 'Alt+Shift+T', cycleDisplayMode: 'Alt+Shift+T', retranslate: 'Alt+Shift+R' };
    const conflicts = detectConflicts(s);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.accelerator).toBe('Alt+Shift+T');
    expect(conflicts[0]?.actions).toContain('toggle');
    expect(conflicts[0]?.actions).toContain('cycleDisplayMode');
  });
  it('validateShortcut：非法 / 冲突 / 合法', () => {
    const s: Shortcuts = { toggle: 'Ctrl', cycleDisplayMode: 'Alt+Shift+D', retranslate: 'Alt+Shift+D' };
    expect(validateShortcut('toggle', s)).toEqual({ ok: false, reason: 'invalid' });
    expect(validateShortcut('cycleDisplayMode', s)).toEqual({ ok: false, reason: 'conflict', conflictWith: 'retranslate' });
    const ok = validateShortcut('retranslate', { ...DEFAULT_SHORTCUTS });
    expect(ok.ok).toBe(true);
  });
  it('非法条目不参与冲突检测', () => {
    const s: Shortcuts = { toggle: 'Ctrl', cycleDisplayMode: 'Ctrl', retranslate: 'Alt+Shift+R' };
    expect(detectConflicts(s)).toEqual([]);
  });
});
