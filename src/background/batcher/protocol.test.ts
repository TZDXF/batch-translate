import { describe, it, expect } from 'vitest';
import {
  buildSystemPrompt,
  buildUserMessage,
  parseResponse,
  alignByIds,
  degradeBatch,
  promptFingerprint,
  DEGRADE_CHUNK_SIZE,
} from './protocol';
import type { Batch, BatchItem, PromptContext, TranslationItem } from './types';

const item = (id: string, text: string): BatchItem => ({ id, text });
const batchOf = (items: BatchItem[]): Batch => ({ id: 'b1', items });
const ctx = (over: Partial<PromptContext> = {}): PromptContext => ({
  targetLang: '简体中文',
  ...over,
});

describe('buildSystemPrompt', () => {
  it('renders the base template: target language + the six rules', () => {
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).toContain('简体中文');
    expect(prompt).toContain('Output ONLY valid JSON, no markdown, no explanation.');
    expect(prompt).toContain('{"items":[{"id":string,"text":string}]}');
    expect(prompt).toContain('Keep every "id" from the input unchanged.');
    expect(prompt).toContain('[[0]], [[1]] verbatim');
    expect(prompt).toContain('Do not merge or split items. One input id → one output id.');
    expect(prompt).toContain('code/URL/untranslatable');
  });

  it('omits the agent block in basic mode', () => {
    const prompt = buildSystemPrompt(ctx());
    expect(prompt).not.toContain('Glossary');
    expect(prompt).not.toContain('Maintain terminology consistency');
  });

  it('appends the agent block when mode === "agent"', () => {
    const prompt = buildSystemPrompt(
      ctx({
        mode: 'agent',
        agent: {
          role: 'You are a senior ML translator.',
          stylePreset: 'technical',
          glossary: [
            { src: 'GPU', tgt: '图形处理器' },
            { src: 'inference', tgt: '推理' },
          ],
          pageContext: 'Title: Transformers',
        },
      }),
    );
    expect(prompt).toContain('You are a senior ML translator.');
    expect(prompt).toContain('Style: technical');
    expect(prompt).toContain('Glossary (must follow, source→target):');
    expect(prompt).toContain('- GPU → 图形处理器');
    expect(prompt).toContain('- inference → 推理');
    expect(prompt).toContain('Context: Title: Transformers');
    expect(prompt).toContain('Maintain terminology consistency across all items.');
  });

  it('omits the style line when stylePreset is "none"', () => {
    const prompt = buildSystemPrompt(ctx({ mode: 'agent', agent: { stylePreset: 'none' } }));
    expect(prompt).not.toMatch(/^Style:/m);
    expect(prompt).toContain('Maintain terminology consistency across all items.');
  });
});

describe('buildUserMessage', () => {
  it('produces the §4.2 JSON envelope and round-trips the items', () => {
    const items = [item('1', 'Hello.'), item('2', 'World.')];
    const message = buildUserMessage(items);
    expect(JSON.parse(message)).toEqual({
      items: [
        { id: '1', text: 'Hello.' },
        { id: '2', text: 'World.' },
      ],
    });
  });
});

describe('parseResponse', () => {
  it('parses a pure JSON envelope', () => {
    const r = parseResponse('{"items":[{"id":"1","text":"你好"},{"id":"2","text":"世界"}]}');
    expect(r).toEqual({ ok: true, items: [{ id: '1', text: '你好' }, { id: '2', text: '世界' }] });
  });

  it('parses a bare array', () => {
    const r = parseResponse('[{"id":"1","text":"你好"}]');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([{ id: '1', text: '你好' }]);
  });

  it('parses a single {id,text} object', () => {
    const r = parseResponse('{"id":"1","text":"你好"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toHaveLength(1);
  });

  it('extracts items from a <json> wrapper', () => {
    const r = parseResponse('<json>{"items":[{"id":"1","text":"你好"}]}</json>');
    expect(r.ok).toBe(true);
  });

  it('extracts items from a markdown ```json code fence', () => {
    const r = parseResponse('```json\n{"items":[{"id":"1","text":"你好"}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0]?.text).toBe('你好');
  });

  it('extracts the first balanced object from surrounding prose', () => {
    const raw = 'Sure! Here is your translation:\n{"items":[{"id":"1","text":"你好"}]}\nHope it helps!';
    const r = parseResponse(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0]?.text).toBe('你好');
  });

  it('coerces numeric ids and text to strings', () => {
    const r = parseResponse('{"items":[{"id":1,"text":42}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items[0]?.id).toBe('1');
      expect(r.items[0]?.text).toBe('42');
    }
  });

  it('returns ok with empty items for {"items":[]}', () => {
    const r = parseResponse('{"items":[]}');
    expect(r).toEqual({ ok: true, items: [] });
  });

  it('drops malformed entries but keeps valid ones', () => {
    const r = parseResponse('{"items":[null,42,{"id":"1","text":"a"}]}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.items).toEqual([{ id: '1', text: 'a' }]);
    }
  });

  it('treats a non-items object as parse failure', () => {
    expect(parseResponse('{"foo":1}').ok).toBe(false);
  });

  it('marks totally unparseable output as a parse error', () => {
    const r = parseResponse('not json at all, no braces either');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('parse');
  });

  it('marks empty/whitespace input as a parse error', () => {
    expect(parseResponse('   ').ok).toBe(false);
    expect(parseResponse('').ok).toBe(false);
  });
});

describe('alignByIds', () => {
  it('fully aligns, order-independent (乱序)', () => {
    const b = batchOf([item('1', 'a'), item('2', 'b'), item('3', 'c')]);
    const res = alignByIds(
      [
        { id: '3', text: '三' },
        { id: '1', text: '一' },
        { id: '2', text: '二' },
      ],
      b,
    );
    expect(res.translated.size).toBe(3);
    expect(res.translated.get('1')).toBe('一');
    expect(res.translated.get('2')).toBe('二');
    expect(res.translated.get('3')).toBe('三');
    expect(res.missing).toEqual([]);
    expect(res.extra).toEqual([]);
  });

  it('partial alignment 18/20 → 18 translated + 2 missing, nothing dropped', () => {
    const b = batchOf(Array.from({ length: 20 }, (_, i) => item(String(i + 1), 'x')));
    const returned: TranslationItem[] = Array.from(
      { length: 20 },
      (_, i) => ({ id: String(i + 1), text: 'T' }),
    ).filter((it) => it.id !== '3' && it.id !== '17'); // drop exactly 2
    const res = alignByIds(returned, b);
    expect(res.translated.size).toBe(18);
    expect(res.missing).toEqual(['3', '17']);
    expect(res.extra).toEqual([]);
  });

  it('flags extra (多返) ids not present in the batch', () => {
    const b = batchOf([item('1', 'a'), item('2', 'b')]);
    const res = alignByIds(
      [
        { id: '1', text: '一' },
        { id: '2', text: '二' },
        { id: '99', text: 'extra' },
      ],
      b,
    );
    expect(res.translated.size).toBe(2);
    expect(res.missing).toEqual([]);
    expect(res.extra).toEqual(['99']);
  });

  it('records missing (缺返) ids', () => {
    const b = batchOf([item('1', 'a'), item('2', 'b'), item('3', 'c')]);
    const res = alignByIds([{ id: '1', text: '一' }], b);
    expect(res.translated.size).toBe(1);
    expect(res.missing).toEqual(['2', '3']);
  });

  it('keeps the first occurrence on duplicate ids; the rest are extra', () => {
    const b = batchOf([item('1', 'a'), item('2', 'b')]);
    const res = alignByIds(
      [
        { id: '1', text: '一' },
        { id: '1', text: 'dup' },
        { id: '2', text: '二' },
      ],
      b,
    );
    expect(res.translated.get('1')).toBe('一');
    expect(res.translated.size).toBe(2);
    expect(res.extra).toEqual(['1']);
  });

  it('accepts a successful ParseOutcome', () => {
    const b = batchOf([item('1', 'a')]);
    const res = alignByIds({ ok: true, items: [{ id: '1', text: '一' }] }, b);
    expect(res.translated.get('1')).toBe('一');
    expect(res.missing).toEqual([]);
  });

  it('accepts a failed ParseOutcome → everything missing', () => {
    const b = batchOf([item('1', 'a'), item('2', 'b')]);
    const res = alignByIds({ ok: false, error: 'parse', raw: 'x' }, b);
    expect(res.translated.size).toBe(0);
    expect(res.missing).toEqual(['1', '2']);
  });
});

describe('degradeBatch', () => {
  const items20 = Array.from({ length: 20 }, (_, i) => item(String(i + 1), 'x'));

  it(`20 → ${20 / DEGRADE_CHUNK_SIZE} batches of ${DEGRADE_CHUNK_SIZE}`, () => {
    const out = degradeBatch({ id: 'b', items: items20 });
    expect(out).toHaveLength(4);
    expect(out.every((b) => b.items.length === 5)).toBe(true);
    expect(out.map((b) => b.id)).toEqual(['b#d0', 'b#d1', 'b#d2', 'b#d3']);
    // no item lost
    expect(out.flatMap((b) => b.items)).toHaveLength(20);
  });

  it('≤5 items → one item per batch (逐段单发)', () => {
    const out = degradeBatch({ id: 'b', items: items20.slice(0, 5) });
    expect(out).toHaveLength(5);
    expect(out.every((b) => b.items.length === 1)).toBe(true);
  });

  it('honors a custom chunkSize', () => {
    const out = degradeBatch({ id: 'b', items: items20 }, 10);
    expect(out).toHaveLength(2);
    expect(out.every((b) => b.items.length === 10)).toBe(true);
  });

  it('returns an empty array for an empty batch', () => {
    expect(degradeBatch({ id: 'b', items: [] })).toEqual([]);
  });
});

describe('promptFingerprint', () => {
  it('is stable for the same context', () => {
    expect(promptFingerprint(ctx())).toBe(promptFingerprint(ctx()));
  });

  it('changes with the target language', () => {
    expect(promptFingerprint(ctx({ targetLang: '简体中文' })).length).toBe(8);
    expect(promptFingerprint(ctx({ targetLang: '简体中文' })).length).toBe(8);
    expect(promptFingerprint(ctx({ targetLang: '简体中文' }))).not.toBe(
      promptFingerprint(ctx({ targetLang: 'English' })),
    );
  });

  it('changes with the agent config', () => {
    const basic = promptFingerprint(ctx());
    const agent = promptFingerprint(ctx({ mode: 'agent', agent: { role: 'senior' } }));
    expect(basic).not.toBe(agent);
  });
});
