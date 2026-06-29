import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock gpt-tokenizer so we can drive both the encode path and the throw→fallback
// path without depending on its exact BPE counts.
vi.mock('gpt-tokenizer', () => ({
  encode: vi.fn(),
}));

import { encode } from 'gpt-tokenizer';
import {
  estimateTokens,
  overheadTokens,
  estimateByCharRatio,
} from './token-estimator';

const mockedEncode = vi.mocked(encode);

beforeEach(() => {
  mockedEncode.mockReset();
});

describe('estimateTokens', () => {
  it('returns 0 for empty input regardless of provider', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('', 'openai')).toBe(0);
  });

  it('uses gpt-tokenizer for the OpenAI family', () => {
    mockedEncode.mockReturnValue([1, 2, 3, 4, 5]);
    expect(estimateTokens('hello world', 'openai')).toBe(5);
    expect(mockedEncode).toHaveBeenCalledWith('hello world');

    mockedEncode.mockReturnValue([1, 1, 1]);
    expect(estimateTokens('x', 'deepseek')).toBe(3);
    expect(estimateTokens('x', 'openai-compatible')).toBe(3);
  });

  it('falls back to the char-ratio heuristic when the tokenizer throws', () => {
    mockedEncode.mockImplementation(() => {
      throw new Error('boom');
    });
    // 3 latin chars × 0.25 = 0.75 → ceil 1
    expect(estimateTokens('abc', 'openai')).toBe(1);
  });

  it('uses the char ratio for non-OpenAI providers / unknown / none', () => {
    expect(estimateTokens('abcd', 'anthropic')).toBe(1); // 4 × 0.25 = 1
    expect(estimateTokens('abcd', 'gemini')).toBe(1);
    expect(estimateTokens('abcd', 'ollama')).toBe(1);
    expect(estimateTokens('abcd', 'something-unknown')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1); // no provider
    expect(mockedEncode).not.toHaveBeenCalled();
  });
});

describe('estimateByCharRatio (heuristic)', () => {
  it('CJK characters use 1.5 tok/char, latin 0.25, rounded up', () => {
    expect(estimateByCharRatio('')).toBe(0);
    expect(estimateByCharRatio('你好')).toBe(3); // 2 × 1.5
    expect(estimateByCharRatio('abcd')).toBe(1); // 4 × 0.25
    expect(estimateByCharRatio('abcde')).toBe(2); // 1.25 → ceil 2
  });

  it('mixes CJK and latin rates per character', () => {
    // 你(1.5) + ab(0.5) = 2.0
    expect(estimateByCharRatio('你ab')).toBe(2);
  });

  it('is conservative: full-width / CJK punctuation counts at the CJK rate', () => {
    expect(estimateByCharRatio('！')).toBe(2); // U+FF01 fullwidth → 1.5 → ceil 2
    expect(estimateByCharRatio('。')).toBe(2); // U+3002 → 1.5 → ceil 2
    expect(estimateByCharRatio('、')).toBe(2); // U+3001 → 1.5 → ceil 2
  });
});

describe('overheadTokens', () => {
  it('estimates prompt tokens through the same provider path', () => {
    mockedEncode.mockReturnValue([1, 2, 3, 4, 5, 6, 7]);
    expect(overheadTokens('a prompt', 'openai')).toBe(7);
  });

  it('uses the char ratio when no OpenAI provider is given', () => {
    expect(overheadTokens('abcdefgh', undefined)).toBe(2); // 8 × 0.25
  });
});
