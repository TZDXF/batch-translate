import { describe, it, expect } from 'vitest';
import { splitBySentence, estimateTokens } from './text-segmenter';

/** 检查字符串中每个 [[ 都是完整占位符 token（未被切断）。 */
function tokensIntact(s: string): boolean {
  const opens = (s.match(/\[\[/g) ?? []).length;
  const complete = (s.match(/\[\[\d+\]\]/g) ?? []).length;
  return opens === complete;
}

describe('estimateTokens', () => {
  it('英文按 ~0.25 tok/char 保守估算', () => {
    expect(estimateTokens('abcdefgh')).toBe(2); // 8 * 0.25 = 2
  });

  it('中文按 1.5 tok/char 估算', () => {
    expect(estimateTokens('你好世界')).toBe(6); // 4 * 1.5 = 6
  });

  it('混合文本按字符类型累加', () => {
    // 2 中文 (3) + 4 英文 (1) = 4
    expect(estimateTokens('你好abcd')).toBe(4);
  });
});

describe('splitBySentence', () => {
  it('短文本不切分，原样返回单元素数组', () => {
    expect(splitBySentence('Hello world.', 100)).toEqual(['Hello world.']);
  });

  it('空串返回空数组', () => {
    expect(splitBySentence('', 10)).toEqual([]);
  });

  it('长文本切成不超过预算的块，且拼接还原原文', () => {
    const text = 'First sentence. Second one! Third? And a fourth sentence here.';
    const chunks = splitBySentence(text, 5);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c)).toBeLessThanOrEqual(5);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('中文按句号 / 感叹号 / 问号切分', () => {
    const text = '这是第一句。这是第二句！还有第三句？最后一句。';
    const chunks = splitBySentence(text, 6);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(estimateTokens(c)).toBeLessThanOrEqual(6);
    }
    expect(chunks.join('')).toBe(text);
  });

  it('绝不切坏 [[n]] 占位符', () => {
    // 无句末标点的超长串 + 一个占位符，强制走硬切路径。
    const long = 'word '.repeat(40) + '[[12]] ' + 'word '.repeat(40);
    const chunks = splitBySentence(long, 8);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(tokensIntact(c)).toBe(true);
      expect(estimateTokens(c)).toBeLessThanOrEqual(8);
    }
    expect(chunks.join('')).toBe(long);
    // 整体仍恰好 1 个完整占位符。
    const allTokens = (chunks.join('').match(/\[\[\d+\]\]/g) ?? []);
    expect(allTokens).toEqual(['[[12]]']);
  });

  it('按子句边界（逗号）切分超限单句', () => {
    const text = 'part one, part two, part three, part four, part five';
    const chunks = splitBySentence(text, 4);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
  });

  it('maxTokens < 1 按 1 处理，不无限切分', () => {
    const chunks = splitBySentence('a b c d', 0);
    expect(chunks.join('')).toBe('a b c d');
    expect(chunks.length).toBeGreaterThan(0);
  });
});
