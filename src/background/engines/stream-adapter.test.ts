/**
 * 流式适配测试（P1-2 / TRA-17 验收）。
 *
 * 覆盖：
 *  - StreamingBatchParser：SSE delta 拼接还原、按 id 对齐、部分文本/转义边界、最终原文。
 *  - openAIStreamDeltas：SSE 事件解析（data 行 / [DONE] / 多事件合包）、abort、非 2xx。
 *  - isStreamingEngine / consumeStreamById。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  StreamingBatchParser,
  openAIStreamDeltas,
  isStreamingEngine,
  consumeStreamById,
  type StreamingEngine,
} from './stream-adapter';
import type { TranslateRequest } from './adapter';

// ── StreamingBatchParser ──────────────────────────────────────────────────

function feedAll(parser: StreamingBatchParser, chunks: string[]): { id: string; delta: string }[] {
  const out: { id: string; delta: string }[] = [];
  for (const c of chunks) out.push(...parser.feed(c));
  return out;
}

function reassemble(deltas: { id: string; delta: string }[]): Record<string, string> {
  const m: Record<string, string> = {};
  for (const d of deltas) m[d.id] = (m[d.id] ?? '') + d.delta;
  return m;
}

describe('StreamingBatchParser — SSE delta 拼接还原', () => {
  it('单 item：逐字符 delta 拼接成完整 text，finalContent 等价整批', () => {
    const parser = new StreamingBatchParser();
    const full = '{"items":[{"id":"1","text":"敏捷的狐狸"}]}';
    // 按单字符喂入（最极端的切断粒度）。
    const chars = [...full].map((c) => c);
    const deltas = feedAll(parser, chars);
    expect(reassemble(deltas)).toEqual({ '1': '敏捷的狐狸' });
    expect(parser.finalContent()).toBe(full);
  });

  it('多 item：按 id 对齐，乱序到达仍能正确归并到各自 id', () => {
    const parser = new StreamingBatchParser();
    const full = '{"items":[{"id":"1","text":"你好"},{"id":"2","text":"世界"}]}';
    // 喂 3 段：前缀 + 第一项 + 第二项。
    const deltas = feedAll(parser, [
      '{"items":[{"id":"1","text":"你好"}',
      ',{"id":"2","text":"世',
      '界"}]}',
    ]);
    expect(reassemble(deltas)).toEqual({ '1': '你好', '2': '世界' });
    expect(parser.finalContent()).toBe(full);
  });

  it('部分 text：item 未闭合时持续发射增量，闭合后不再重复', () => {
    const parser = new StreamingBatchParser();
    // id 先到、text 逐步增长。
    parser.feed('{"items":[{"id":"7","text":"a');
    const d1 = parser.feed('bc');
    const d2 = parser.feed('d"}]}');
    expect(reassemble(d1)).toEqual({ '7': 'bc' });
    expect(reassemble(d2)).toEqual({ '7': 'd' });
    // 闭合后再喂入新内容不应重复发射 id=7。
    const d3 = parser.feed('');
    expect(d3).toHaveLength(0);
  });

  it('转义边界：text 含 \\n / \\" / \\\\ 且 delta 切在转义中途，仍正确还原', () => {
    const parser = new StreamingBatchParser();
    // text = a"b\c（JSON: "a\"b\\c"）
    const full = '{"items":[{"id":"1","text":"a\\"b\\\\c"}]}';
    // 故意切在转义中间。
    const deltas = feedAll(parser, [
      '{"items":[{"id":"1","text":"a\\',
      '"b\\\\',
      'c"}]}',
    ]);
    expect(reassemble(deltas)).toEqual({ '1': 'a"b\\c' });
    expect(parser.finalContent()).toBe(full);
  });

  it('未闭合转义尾部（\\u 截断）：尽力还原，不抛错', () => {
    const parser = new StreamingBatchParser();
    // 中 切成 \u4e 后中断（流式尾部）。
    parser.feed('{"items":[{"id":"1","text":"\\u4e');
    // 未闭合 → 不应抛错；decoded 为尽力结果（裁掉不完整 \u）。
    // 这里只断言不崩 + finalContent 累计正确。
    expect(parser.finalContent()).toBe('{"items":[{"id":"1","text":"\\u4e');
  });

  it('前缀噪声：引擎先吐思考文本再吐 JSON，仍能定位 items 数组', () => {
    const parser = new StreamingBatchParser();
    const deltas = feedAll(parser, [
      '正在思考... ', // 前缀噪声
      '{"items":[',
      '{"id":"9","text":"ok"}]}',
    ]);
    expect(reassemble(deltas)).toEqual({ '9': 'ok' });
  });

  it('空 items / 无 items 键：不发射 delta，不抛错', () => {
    const parser = new StreamingBatchParser();
    expect(parser.feed('{"items":[]}')).toHaveLength(0);
    expect(parser.feed('{"other":1}')).toHaveLength(0);
    // finalContent 是累计原文（两段都喂入了 buffer）。
    expect(parser.finalContent()).toBe('{"items":[]}{"other":1}');
  });

  it('reset 后可复用处理新批次', () => {
    const parser = new StreamingBatchParser();
    feedAll(parser, ['{"items":[{"id":"1","text":"x"}]}']);
    parser.reset();
    const deltas = feedAll(parser, ['{"items":[{"id":"2","text":"y"}]}']);
    expect(reassemble(deltas)).toEqual({ '2': 'y' });
  });
});

// ── openAIStreamDeltas ────────────────────────────────────────────────────

/** 构造一个 SSE 响应 ReadableStream。 */
function sseResponse(chunks: string[], init?: { status?: number }): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  const status = init?.status ?? 200;
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

describe('openAIStreamDeltas — OpenAI 兼容 SSE 解析', () => {
  it('逐 data 行拼接 delta.content，[DONE] 结束', async () => {
    const events = [
      'data: {"choices":[{"delta":{"content":"你好"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"，世界"}}]}\n\n',
      'data: [DONE]\n\n',
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse(events));
    const deltas: string[] = [];
    for await (const d of openAIStreamDeltas('http://x/v1/chat/completions', {}, '{}')) deltas.push(d);
    expect(deltas.join('')).toBe('你好，世界');
  });

  it('多事件合并在一个 chunk（\\n\\n 分隔）也能正确切分', async () => {
    const blob =
      'data: {"choices":[{"delta":{"content":"A"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"B"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"C"}}]}\n\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([blob]));
    const deltas: string[] = [];
    for await (const d of openAIStreamDeltas('u', {}, '{}')) deltas.push(d);
    expect(deltas).toEqual(['A', 'B', 'C']);
  });

  it('CRLF 分隔（\\r\\n\\r\\n）兼容', async () => {
    const blob = 'data: {"choices":[{"delta":{"content":"X"}}]}\r\n\r\n';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(sseResponse([blob]));
    const deltas: string[] = [];
    for await (const d of openAIStreamDeltas('u', {}, '{}')) deltas.push(d);
    expect(deltas).toEqual(['X']);
  });

  it('非 2xx 抛 EngineRequestError 含 status', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{"error":{"message":"rate"}}', { status: 429 }),
    );
    await expect(async () => {
      for await (const _d of openAIStreamDeltas('u', {}, '{}')) {
        void _d;
      }
    }).rejects.toMatchObject({ name: 'EngineRequestError', status: 429 });
  });

  it('abort：signal 已 aborted 时 fetch 抛 AbortError 原样上抛', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new DOMException('aborted', 'AbortError')));
    await expect(async () => {
      for await (const _d of openAIStreamDeltas('u', {}, '{}', ac.signal)) {
        void _d;
      }
    }).rejects.toMatchObject({ name: 'AbortError' });
  });
});

// ── isStreamingEngine / consumeStreamById ──────────────────────────────────

describe('isStreamingEngine / consumeStreamById', () => {
  it('isStreamingEngine：有 translateStream 函数即识别', () => {
    const plain = { id: 'e', provider: 'openai', translate: () => Promise.resolve({ content: '' }) };
    const streamer: StreamingEngine = { async *translateStream() { yield { type: 'done', content: '' }; } };
    expect(isStreamingEngine(plain)).toBe(false);
    expect(isStreamingEngine(streamer)).toBe(true);
  });

  it('consumeStreamById：delta 流喂 parser，按 id 回调，返回完整原文', async () => {
    const engine: StreamingEngine = {
      async *translateStream() {
        yield { type: 'delta', content: '{"items":[{"id":"1","text":"你' };
        yield { type: 'delta', content: '好"}]}' };
        yield { type: 'done', content: '{"items":[{"id":"1","text":"你好"}]}' };
      },
    };
    const parser = new StreamingBatchParser();
    const seen: { id: string; delta: string }[] = [];
    const full = await consumeStreamById(engine, {} as TranslateRequest, parser, (id, delta) => seen.push({ id, delta }));
    expect(full).toBe('{"items":[{"id":"1","text":"你好"}]}');
    expect(reassemble(seen)).toEqual({ '1': '你好' });
  });

  it('consumeStreamById：引擎抛错原样上抛（AbortError 不吞）', async () => {
    const engine: StreamingEngine = {
      async *translateStream() {
        yield { type: 'delta', content: 'partial' };
        throw new DOMException('aborted', 'AbortError');
      },
    };
    const parser = new StreamingBatchParser();
    await expect(
      consumeStreamById(engine, {} as TranslateRequest, parser, () => {}),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
