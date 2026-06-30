/**
 * Batch packer (ARCHITECTURE.md §4.5).
 *
 * Greedily groups translatable items into batches that each fit a per-batch
 * input-token budget:
 *   - Each batch's running token count starts at the system-prompt overhead and
 *     accumulates per-item estimates.
 *   - Adding an item that would overflow the budget flushes the current batch.
 *   - A single item that by itself exceeds the budget is split by sentence
 *     (then by character as a last resort) into sub-items that fit.
 *   - Batches that fill past 90% of the budget are flushed early to leave headroom.
 *   - Finally each batch is capped at MAX_ITEMS_PER_BATCH items (default 20), so a
 *     single alignment/retry failure never carries too large a payload.
 *
 * Pure function: no DOM, no fetch, no browser API.
 */
import type { Batch, BatchItem, TokenBudget } from './types';
import { estimateTokens, overheadTokens } from './token-estimator';

/** Hard ceiling on items per batch (ARCHITECTURE.md §5.3: itemsPerBatch=20). */
export const MAX_ITEMS_PER_BATCH = 20;

/**
 * Pack `items` into batches respecting `budget`. `systemPrompt` is the prompt
 * whose token overhead must be reserved in every batch (pass '' for none).
 */
export function pack(items: BatchItem[], budget: TokenBudget, systemPrompt = ''): Batch[] {
  if (items.length === 0) return [];

  const inputMax = budget.inputMax;
  const maxItems = budget.maxItems ?? MAX_ITEMS_PER_BATCH;
  const overhead = overheadTokens(systemPrompt);

  // Pass 1 — pack by token budget, splitting oversized single items by sentence.
  const tokenBatches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let currentTokens = overhead;

  const flush = (): void => {
    if (current.length > 0) {
      tokenBatches.push(current);
      current = [];
    }
    currentTokens = overhead;
  };

  for (const item of items) {
    const itemTokens = estimateTokens(item.text);

    // Adding this item would overflow a non-empty batch → close it first.
    if (current.length > 0 && currentTokens + itemTokens > inputMax) {
      flush();
    }

    if (itemTokens > inputMax) {
      // Single item exceeds the whole budget → sentence-split into sub-items.
      const subMax = Math.max(1, Math.floor(inputMax * 0.8));
      for (const sub of splitBySentence(item, subMax)) {
        const subTokens = estimateTokens(sub.text);
        if (current.length > 0 && currentTokens + subTokens > inputMax) flush();
        current.push(sub);
        currentTokens += subTokens;
      }
    } else {
      current.push(item);
      currentTokens += itemTokens;
    }

    // 90% headroom flush — start a fresh batch before it gets too tight.
    if (currentTokens >= inputMax * 0.9) flush();
  }
  flush();

  // Pass 2 — cap each token-batch by the item-count limit.
  const batches: Batch[] = [];
  let index = 0;
  for (const tb of tokenBatches) {
    for (let i = 0; i < tb.length; i += maxItems) {
      const slice = tb.slice(i, i + maxItems);
      batches.push({ id: `batch-${index++}`, items: slice });
    }
  }
  return batches;
}

/**
 * Split an oversized item into sub-items, each fitting within `maxTokens`.
 * Sub-items carry derived ids `${originalId}#${n}` so the orchestrator can
 * reassemble them (group by the `#`-prefix). Greedy by sentence, with a
 * per-character hard split for any single sentence that still overflows.
 *
 * (The content extractor's splitBySentence in TRA-8 is the primary cutter; this
 * is the packer's safety net for an item that slips through still oversized.)
 */
export function splitBySentence(item: BatchItem, maxTokens: number): BatchItem[] {
  const sentences = segmentSentences(item.text);
  const chunks: string[] = [];
  let buffer = '';
  let bufferTokens = 0;

  const flushBuffer = (): void => {
    if (buffer) {
      chunks.push(buffer);
      buffer = '';
      bufferTokens = 0;
    }
  };

  for (const sentence of sentences) {
    const sentenceTokens = estimateTokens(sentence);
    if (sentenceTokens > maxTokens) {
      // A single sentence is still too big → flush, then hard-split by char.
      flushBuffer();
      for (const piece of hardSplit(sentence, maxTokens)) chunks.push(piece);
      continue;
    }
    if (bufferTokens + sentenceTokens > maxTokens && buffer) {
      flushBuffer();
    }
    buffer += sentence;
    bufferTokens += sentenceTokens;
  }
  flushBuffer();

  // Fallback: nothing segmentable produced (e.g. empty text) → keep original.
  if (chunks.length === 0) return [item];
  return chunks.map((text, i) => ({ id: `${item.id}#${i}`, text }));
}

/** Sentence segmentation that preserves delimiters (CJK + latin + newlines). */
function segmentSentences(text: string): string[] {
  if (!text) return [];
  // Split with a capture group so delimiters are kept as their own segments.
  const parts = text.split(/([。！？!?；;\n\r]+|\.\s+)/);
  const out: string[] = [];
  let acc = '';
  for (const part of parts) {
    acc += part;
    if (/[。！？!?；;\n\r]+|\.\s+/.test(part)) {
      if (acc.trim()) out.push(acc);
      acc = '';
    }
  }
  if (acc.trim()) out.push(acc);
  return out;
}

/** Per-character hard split guaranteeing each chunk stays ≤ `maxTokens`. */
function hardSplit(text: string, maxTokens: number): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let buffer = '';
  for (const ch of chars) {
    buffer += ch;
    if (buffer.length > 1 && estimateTokens(buffer) > maxTokens) {
      buffer = buffer.slice(0, -1);
      chunks.push(buffer);
      buffer = ch;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}
