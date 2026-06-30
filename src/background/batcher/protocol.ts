/**
 * Batch translation protocol (ARCHITECTURE.md §4.2–4.6).
 *
 * Owns the request/response contract with the LLM for one batch:
 *   - buildSystemPrompt / buildUserMessage — assemble the prompt (basic mode now;
 *     an agent/expert extension point is wired for P1).
 *   - parseResponse — tolerant JSON extraction (direct → <json>/code-fence →
 *     first balanced object).
 *   - alignByIds — verify returned ids line up with the batch, surfacing the
 *     translated set, the missing ids, and any extras. Failure is located to the
 *     segment so the orchestrator never re-translates a whole batch.
 *   - degradeBatch — split a failed batch into smaller batches for retry.
 *   - promptFingerprint — stable hash of the prompt config for cache keys.
 *
 * Pure functions: no DOM, no fetch, no browser API. (Decoupled from the engine
 * layer — that does the actual request.)
 */
import type { AgentPromptContext, PromptContext } from './types';
import type { Batch, BatchItem, TranslationItem } from './types';

/** Default degradation chunk size: 20 items → 4×5 (ARCHITECTURE.md §4.6). */
export const DEGRADE_CHUNK_SIZE = 5;

/** Outcome of parsing a raw LLM response. */
export type ParseOutcome =
  | { ok: true; items: TranslationItem[] }
  | { ok: false; error: 'parse'; raw: string };

/** Alignment result: what got translated, what's still missing, what was extra. */
export interface AlignResult {
  /** id → translated text, one entry per matched input id (first wins on dup). */
  translated: Map<string, string>;
  /** Input ids the LLM did not return (re-send these, never the whole batch). */
  missing: string[];
  /** Returned ids not in the input, or duplicate ids (diagnostics only). */
  extra: string[];
}

/**
 * Build the system prompt. Basic mode renders the base translator template
 * (ARCHITECTURE.md §4.3). When `ctx.mode === 'agent'` and `ctx.agent` is
 * provided, the agent block (role / style / glossary / page context) is appended
 * — the P1 agent/expert hook, implemented now as plain string assembly so the
 * signature already accepts the extension point.
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const lines: string[] = [];
  lines.push(
    `You are a professional translator. Translate the user-provided text into ${ctx.targetLang}.`,
  );
  lines.push('Rules:');
  lines.push('1. Output ONLY valid JSON, no markdown, no explanation.');
  lines.push('2. Output schema: {"items":[{"id":string,"text":string}]}.');
  lines.push(
    '3. Keep every "id" from the input unchanged. Return exactly one translation per input id.',
  );
  lines.push(
    '4. Preserve inline markup placeholders like [[0]], [[1]] verbatim — do not translate, reorder, or delete them.',
  );
  lines.push('5. Do not merge or split items. One input id → one output id.');
  lines.push(
    '6. If an item is code/URL/untranslatable, return it unchanged in "text".',
  );

  if (ctx.mode === 'agent' && ctx.agent) {
    lines.push('');
    lines.push(...buildAgentBlock(ctx.agent));
  }
  return lines.join('\n');
}

/** Agent/expert mode additions (ARCHITECTURE.md §4.3 agent template). */
function buildAgentBlock(agent: AgentPromptContext): string[] {
  const block: string[] = [];
  if (agent.role) block.push(agent.role);
  if (agent.stylePreset && agent.stylePreset !== 'none') {
    block.push(`Style: ${agent.stylePreset}`);
  }
  if (agent.glossary && agent.glossary.length > 0) {
    block.push('Glossary (must follow, source→target):');
    for (const pair of agent.glossary) {
      block.push(`- ${pair.src} → ${pair.tgt}`);
    }
  }
  if (agent.pageContext) {
    block.push(`Context: ${agent.pageContext}`);
  }
  block.push('Maintain terminology consistency across all items.');
  return block;
}

/**
 * Build the user message — the §4.2 JSON envelope holding every item with its
 * stable id. Returned as a string so the engine adapter ships it verbatim.
 */
export function buildUserMessage(items: BatchItem[]): string {
  return JSON.stringify({
    items: items.map((item) => ({ id: item.id, text: item.text })),
  });
}

/**
 * Parse a raw LLM response into a normalized list of translation items.
 *
 * Tolerant chain (ARCHITECTURE.md §4.4): direct JSON.parse → `<json>` tag →
 * markdown code fence → first balanced `{...}` object. Accepts the canonical
 * `{items:[...]}` envelope, a bare array `[...]`, or a single `{id,text}`.
 * Ids/text are coerced to strings. Returns `{ok:false}` only if nothing parses.
 */
export function parseResponse(raw: string, _batch?: Batch): ParseOutcome {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return { ok: false, error: 'parse', raw: text };

  // 1. Direct parse.
  let items = tryParseItems(text);
  if (items !== null) return { ok: true, items };

  // 2. <json>...</json> wrapper.
  const jsonTag = text.match(/<json[^>]*>([\s\S]*?)<\/json>/i);
  if (jsonTag && jsonTag[1] !== undefined) {
    items = tryParseItems(jsonTag[1].trim());
    if (items !== null) return { ok: true, items };
  }

  // 3. Markdown code fence ```json ... ``` / ``` ... ```.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1] !== undefined) {
    items = tryParseItems(fence[1].trim());
    if (items !== null) return { ok: true, items };
  }

  // 4. First balanced {...} object embedded in prose.
  const object = extractFirstObject(text);
  if (object !== null) {
    items = tryParseItems(object);
    if (items !== null) return { ok: true, items };
  }

  return { ok: false, error: 'parse', raw: text };
}

/**
 * Align parsed items back to the batch's input ids (ARCHITECTURE.md §4.6).
 * Order-independent (keyed by id). Handles full / partial / extra (多返) /
 * missing (缺返) / out-of-order (乱序) / duplicate returns without ever dropping
 * a segment — anything unmatched lands in `missing`.
 *
 * Accepts either a raw item array or a ParseOutcome (a failed outcome yields all
 * ids missing, translated empty).
 */
export function alignByIds(parsed: TranslationItem[] | ParseOutcome, batch: Batch): AlignResult {
  const items: TranslationItem[] = Array.isArray(parsed)
    ? parsed
    : parsed.ok
      ? parsed.items
      : [];

  const batchIds = new Set(batch.items.map((item) => item.id));
  const translated = new Map<string, string>();
  const extra: string[] = [];
  const seen = new Set<string>();

  for (const entry of items) {
    if (batchIds.has(entry.id) && !seen.has(entry.id)) {
      translated.set(entry.id, entry.text);
      seen.add(entry.id);
    } else {
      extra.push(entry.id);
    }
  }

  const missing = batch.items.map((item) => item.id).filter((id) => !seen.has(id));
  return { translated, missing, extra };
}

/**
 * Degrade a failed batch into smaller batches for retry (ARCHITECTURE.md §4.6).
 *
 * Default: a batch larger than DEGRADE_CHUNK_SIZE (5) is split into chunks of 5
 * (so 20 → 4×5); a batch already ≤5 degrades all the way to one item per batch
 * (逐段单发). Pass `chunkSize` to override. Sub-batch ids derive from the parent.
 */
export function degradeBatch(batch: Batch, chunkSize?: number): Batch[] {
  const total = batch.items.length;
  if (total === 0) return [];

  const size =
    chunkSize !== undefined
      ? Math.max(1, Math.floor(chunkSize))
      : total > DEGRADE_CHUNK_SIZE
        ? DEGRADE_CHUNK_SIZE
        : 1;

  const out: Batch[] = [];
  for (let i = 0; i < total; i += size) {
    out.push({
      id: `${batch.id}#d${out.length}`,
      items: batch.items.slice(i, i + size),
    });
  }
  return out;
}

/**
 * Stable fingerprint of the prompt configuration for cache keys. Pure,
 * synchronous (djb2 over the built system prompt) — no Web Crypto, so it stays
 * out of the browser-API boundary. The cache layer (TRA-7) combines this with
 * source text + engine id + target lang into its sha256 key.
 */
export function promptFingerprint(ctx: PromptContext): string {
  const prompt = buildSystemPrompt(ctx);
  let hash = 5381;
  for (let i = 0; i < prompt.length; i++) {
    hash = ((hash << 5) + hash + prompt.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Parse a JSON string and normalize to translation items, or null if not usable. */
function tryParseItems(source: string): TranslationItem[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  return normalizeItems(parsed);
}

/** Normalize a parsed value into TranslationItem[], tolerating envelope shapes. */
function normalizeItems(parsed: unknown): TranslationItem[] | null {
  let arr: unknown[] | null = null;
  if (Array.isArray(parsed)) {
    arr = parsed;
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { items?: unknown }).items)
  ) {
    arr = (parsed as { items: unknown[] }).items;
  } else if (
    parsed !== null &&
    typeof parsed === 'object' &&
    'id' in (parsed as Record<string, unknown>) &&
    'text' in (parsed as Record<string, unknown>)
  ) {
    arr = [parsed];
  }
  if (arr === null) return null;

  const items: TranslationItem[] = [];
  for (const entry of arr) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.id === undefined || record.id === null) continue;
    if (record.text === undefined || record.text === null) continue;
    items.push({ id: String(record.id), text: String(record.text) });
  }
  return items;
}

/** Extract the first brace-balanced `{...}` substring, respecting strings/escapes. */
function extractFirstObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
