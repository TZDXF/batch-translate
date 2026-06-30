import { describe, it, expect } from 'vitest';
import { resolveGlossary, formatGlossarySection } from './glossary';
import type { GlossaryPair } from '../../types/agent';

describe('glossary', () => {
  describe('resolveGlossary', () => {
    it('returns empty for no ids', () => {
      expect(resolveGlossary([], new Map())).toEqual([]);
      expect(resolveGlossary(undefined, new Map())).toEqual([]);
    });

    it('resolves ids to pairs in order, skipping unknown ids', () => {
      const lookup = new Map<string, GlossaryPair[]>([
        ['g1', [{ src: 'GPU', tgt: '图形处理器' }]],
        ['g2', [{ src: 'inference', tgt: '推理' }]],
      ]);
      const out = resolveGlossary(['g1', 'missing', 'g2'], lookup);
      expect(out).toEqual([
        { src: 'GPU', tgt: '图形处理器' },
        { src: 'inference', tgt: '推理' },
      ]);
    });

    it('dedups identical pairs across glossaries', () => {
      const lookup = new Map<string, GlossaryPair[]>([
        ['g1', [{ src: 'GPU', tgt: '图形处理器' }]],
        ['g2', [{ src: 'GPU', tgt: '图形处理器' }, { src: 'cache', tgt: '缓存' }]],
      ]);
      const out = resolveGlossary(['g1', 'g2'], lookup);
      expect(out).toEqual([
        { src: 'GPU', tgt: '图形处理器' },
        { src: 'cache', tgt: '缓存' },
      ]);
    });
  });

  describe('formatGlossarySection', () => {
    it('returns empty string for empty/undefined pairs', () => {
      expect(formatGlossarySection([])).toBe('');
      expect(formatGlossarySection(undefined)).toBe('');
    });

    it('renders the "must follow" header + bullet list (架构 4.3 格式)', () => {
      const out = formatGlossarySection([
        { src: 'GPU', tgt: '图形处理器' },
        { src: 'inference', tgt: '推理' },
      ]);
      expect(out).toContain('Glossary (must follow, source→target):');
      expect(out).toContain('- GPU → 图形处理器');
      expect(out).toContain('- inference → 推理');
      // 每条一行
      expect(out.split('\n').length).toBe(3);
    });
  });
});
