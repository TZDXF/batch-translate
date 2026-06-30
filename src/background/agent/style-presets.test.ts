import { describe, it, expect } from 'vitest';
import {
  STYLE_PRESETS,
  resolveStyleInstruction,
  listStylePresets,
} from './style-presets';

describe('style-presets', () => {
  it('exposes the three built-in presets (信达雅/学术/口语)', () => {
    expect(STYLE_PRESETS.literary).toContain('信达雅');
    expect(STYLE_PRESETS.technical).toContain('学术');
    expect(STYLE_PRESETS.casual).toContain('口语化');
  });

  it('resolveStyleInstruction returns the preset text for known presets', () => {
    expect(resolveStyleInstruction('literary')).toBe(STYLE_PRESETS.literary);
    expect(resolveStyleInstruction('technical')).toBe(STYLE_PRESETS.technical);
    expect(resolveStyleInstruction('casual')).toBe(STYLE_PRESETS.casual);
  });

  it('resolveStyleInstruction returns empty string for "none" / undefined / unknown', () => {
    expect(resolveStyleInstruction('none')).toBe('');
    expect(resolveStyleInstruction(undefined)).toBe('');
    expect(resolveStyleInstruction('wat' as never)).toBe('');
  });

  it('listStylePresets includes none + the three built-ins', () => {
    const list = listStylePresets();
    expect(list).toContain('none');
    expect(list).toContain('literary');
    expect(list).toContain('technical');
    expect(list).toContain('casual');
    expect(list.length).toBe(4);
  });
});
