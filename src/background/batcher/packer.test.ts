import { describe, it, expect, vi } from 'vitest';

// Deterministic token model: 1 token per character. This isolates packer logic
// from the real estimator so batch boundaries are exact and easy to reason about.
vi.mock('./token-estimator', () => ({
  estimateTokens: vi.fn((text: string) => text.length),
  overheadTokens: vi.fn((prompt: string) => prompt.length),
}));

import { pack, splitBySentence, MAX_ITEMS_PER_BATCH } from './packer';
import type { BatchItem, TokenBudget } from './types';

const item = (id: string, text: string): BatchItem => ({ id, text });
const budget = (inputMax: number, maxItems?: number): TokenBudget => ({
  inputMax,
  maxItems,
});

describe('pack', () => {
  it('returns an empty array for empty input', () => {
    expect(pack([], budget(100))).toEqual([]);
  });

  it('packs everything into a single batch when under budget', () => {
    const items = [item('1', 'aa'), item('2', 'bb'), item('3', 'cc')]; // 6 tokens
    const batches = pack(items, budget(100), '');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items).toHaveLength(3);
    expect(batches[0]!.id).toBe('batch-0');
  });

  it('flushes a new batch when the next item would overflow', () => {
    // 5-token items, inputMax 20, overhead 0.
    const items = ['aaaaa', 'bbbbb', 'ccccc', 'ddddd', 'eeeee'].map((t, i) =>
      item(String(i + 1), t),
    );
    const batches = pack(items, budget(20), '');
    // items 1–4 fill exactly 20 → 0.9·20=18 early-flush; item 5 → own batch.
    expect(batches).toHaveLength(2);
    expect(batches[0]!.items.map((i) => i.id)).toEqual(['1', '2', '3', '4']);
    expect(batches[1]!.items.map((i) => i.id)).toEqual(['5']);
  });

  it('keeps an exactly-full set in one batch', () => {
    const items = ['aaaaa', 'bbbbb', 'ccccc', 'ddddd'].map((t, i) =>
      item(String(i + 1), t),
    ); // 20 tokens total
    const batches = pack(items, budget(20), '');
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items).toHaveLength(4);
  });

  it('splits a single oversized item by sentence', () => {
    // inputMax 10; the item is 15 chars (3 sentences × 5 incl. delimiter) > 10.
    const oversized = item('9', 'aaaa。bbbb。cccc。');
    const batches = pack([oversized], budget(10), '');
    const all = batches.flatMap((b) => b.items);

    // Sub-items carry derived ids and each chunk fits the 0.8·inputMax budget.
    expect(all.some((i) => i.id.startsWith('9#'))).toBe(true);
    for (const it of all) expect(it.text.length).toBeLessThanOrEqual(8);
    // Content is preserved in order.
    expect(all.map((i) => i.text).join('')).toBe('aaaa。bbbb。cccc。');
  });

  it(`caps batches at MAX_ITEMS_PER_BATCH (${MAX_ITEMS_PER_BATCH})`, () => {
    const items = Array.from({ length: 50 }, (_, i) => item(String(i + 1), 'a')); // 1 token each
    const batches = pack(items, budget(10_000), '');
    expect(batches).toHaveLength(3);
    expect(batches[0]!.items).toHaveLength(20);
    expect(batches[1]!.items).toHaveLength(20);
    expect(batches[2]!.items).toHaveLength(10);
  });

  it('honors a custom maxItems override', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(String(i + 1), 'a'));
    const batches = pack(items, budget(10_000, 5), '');
    expect(batches).toHaveLength(2);
    expect(batches.every((b) => b.items.length <= 5)).toBe(true);
  });

  it('reserves system-prompt overhead inside each batch budget', () => {
    // overhead 'pppp' = 4; items 5 tokens each; inputMax 9 → one item per batch.
    const batches = pack([item('1', 'aaaaa'), item('2', 'bbbbb')], budget(9), 'pppp');
    expect(batches).toHaveLength(2);
    expect(batches[0]!.items.map((i) => i.id)).toEqual(['1']);
    expect(batches[1]!.items.map((i) => i.id)).toEqual(['2']);
  });

  it('never lets any batch exceed the input budget', () => {
    const items = Array.from({ length: 30 }, (_, i) => item(String(i + 1), 'abcd')); // 4 tokens
    const batches = pack(items, budget(15), '');
    for (const b of batches) {
      const used = b.items.reduce((sum, i) => sum + i.text.length, 0);
      expect(used).toBeLessThanOrEqual(15);
    }
  });

  it('assigns sequential, unique batch ids', () => {
    const items = Array.from({ length: 6 }, (_, i) => item(String(i + 1), 'aaaaa'));
    const batches = pack(items, budget(10), '');
    const ids = batches.map((b) => b.id);
    expect(ids).toEqual(ids.map((_, i) => `batch-${i}`));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('splitBySentence', () => {
  it('splits on sentence boundaries and assigns derived ids', () => {
    const subs = splitBySentence(item('1', '一。二。三。'), 2);
    expect(subs).toHaveLength(3);
    expect(subs.map((s) => s.id)).toEqual(['1#0', '1#1', '1#2']);
    expect(subs.map((s) => s.text).join('')).toBe('一。二。三。');
  });

  it('greedily groups sentences that fit together', () => {
    // each sentence 2 tokens, maxTokens 5 → two fit per chunk (2+2=4 ≤5).
    const subs = splitBySentence(item('1', '一。二。三。四。'), 5);
    expect(subs.map((s) => s.text)).toEqual(['一。二。', '三。四。']);
  });

  it('hard-splits a single sentence that still exceeds maxTokens', () => {
    const subs = splitBySentence(item('1', 'aaaaaaaaaaaaaaaaaaaa'), 5); // 20 chars, no boundary
    expect(subs).toHaveLength(4);
    for (const s of subs) expect(s.text.length).toBeLessThanOrEqual(5);
    expect(subs.map((s) => s.text).join('')).toBe('aaaaaaaaaaaaaaaaaaaa');
  });

  it('returns the original item when the text is empty', () => {
    expect(splitBySentence(item('1', ''), 100)).toEqual([item('1', '')]);
  });
});
