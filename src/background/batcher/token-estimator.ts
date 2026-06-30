/**
 * Token estimation (ARCHITECTURE.md §4.5).
 *
 * OpenAI-family providers use gpt-tokenizer (BPE) for an accurate count; every
 * other provider (Anthropic / Gemini / Ollama / unknown) falls back to a
 * conservative per-character heuristic:
 *   - CJK characters (incl. kana, hangul, full-width forms): 1.5 tok/char
 *   - latin / everything else:                                0.25 tok/char
 * Ambiguous characters are counted at the higher rate ("保守取大") so the budget
 * over- rather than under-estimates, keeping batches safely inside the context
 * window. All results are rounded up.
 *
 * Pure function: no DOM, no fetch, no browser API.
 */
import { encode } from 'gpt-tokenizer';

export type TokenProvider =
  | 'openai'
  | 'openai-compatible'
  | 'deepseek'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | (string & {});

/** Providers whose tokenizer gpt-tokenizer can approximate well enough. */
const OPENAI_FAMILY = new Set<TokenProvider>(['openai', 'openai-compatible', 'deepseek']);

/**
 * Estimate the token count of `text`.
 *
 * For OpenAI-family `provider`, counts via gpt-tokenizer (with a safe fallback
 * to the char-ratio heuristic if the tokenizer ever throws). For any other
 * provider — or when no provider is given — uses the conservative char ratio.
 */
export function estimateTokens(text: string, provider?: TokenProvider): number {
  if (!text) return 0;

  if (provider && OPENAI_FAMILY.has(provider)) {
    const encoded = encodeByTokenizer(text);
    if (encoded != null) return encoded;
  }
  return estimateByCharRatio(text);
}

/**
 * Prompt/structural overhead in tokens. Used by the packer to reserve room for
 * the system prompt inside each batch's input budget (ARCHITECTURE.md §4.5
 * pseudo: `curTokens = overheadTokens(systemPrompt)`).
 */
export function overheadTokens(prompt: string, provider?: TokenProvider): number {
  return estimateTokens(prompt, provider);
}

/** gpt-tokenizer encode wrapped so any unexpected throw degrades gracefully. */
function encodeByTokenizer(text: string): number | null {
  try {
    return encode(text).length;
  } catch {
    return null;
  }
}

/** Conservative per-character estimate; rounds up. */
export function estimateByCharRatio(text: string): number {
  let tokens = 0;
  for (const ch of text) {
    tokens += isCJK(ch) ? 1.5 : 0.25;
  }
  return Math.ceil(tokens);
}

/**
 * Broad CJK / full-width classification. Returns true for characters that
 * tokenize at the denser 1.5 tok/char rate; anything not clearly latin is
 * treated as CJK ("保守取大") so the estimate stays on the safe side.
 */
function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0)!; // `for..of` always yields ≥1-char strings
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK symbols & punctuation
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef)    // Fullwidth / Halfwidth forms
  );
}
