import { describe, it, expect, vi } from 'vitest';
import {
  OpenAIEngine,
  buildRequestBody,
  resolveChatCompletionsUrl,
  parseRetryAfter,
} from '../engines/openai';
import { EngineError } from '../engines/adapter';
import type { TranslateRequest } from '../engines/adapter';
import { fakeSecretStore } from './helpers';

const baseReq: TranslateRequest = {
  systemPrompt: 'You are a translator.',
  userMessage: '{"items":[{"id":"1","text":"hello"}]}',
  targetLang: 'zh',
  jsonMode: true,
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

/** 断言时从 mock 调用里取出的 init 视图。 */
type CallInit = {
  method: string;
  headers: Record<string, string>;
  body: string;
};

function makeEngine(opts: {
  // 用 unknown 承接任意 vi.fn mock；内部 cast 为 typeof fetch。
  fetchFn: unknown;
  key?: string;
  baseUrl?: string;
  model?: string;
  id?: string;
  provider?: 'openai' | 'openai-compatible';
}): OpenAIEngine {
  return new OpenAIEngine({
    id: opts.id ?? 'openai-default',
    provider: opts.provider ?? 'openai-compatible',
    baseUrl: opts.baseUrl ?? 'https://api.openai.com',
    model: opts.model ?? 'gpt-4o-mini',
    apiKeyRef: 'ref-openai',
    secretStore: fakeSecretStore({ key: opts.key ?? 'sk-test' }),
    fetchFn: opts.fetchFn as unknown as typeof fetch,
  });
}

/** mock fetch 声明 (url, init) 参数签名，使 mock.calls[0] 可按元组索引。 */
function mockFetch(
  impl: (url: string, init: RequestInit) => Response | Promise<Response>,
) {
  return vi.fn(impl);
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  return p.then(() => null, (e) => e);
}

describe('buildRequestBody', () => {
  it('builds system+user messages with temperature 0', () => {
    const body = buildRequestBody('gpt-4o-mini', baseReq);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.messages).toEqual([
      { role: 'system', content: baseReq.systemPrompt },
      { role: 'user', content: baseReq.userMessage },
    ]);
  });

  it('adds response_format json_object when jsonMode', () => {
    expect(buildRequestBody('m', baseReq).response_format).toEqual({
      type: 'json_object',
    });
  });

  it('omits response_format when jsonMode is false', () => {
    expect(
      buildRequestBody('m', { ...baseReq, jsonMode: false }).response_format,
    ).toBeUndefined();
  });
});

describe('resolveChatCompletionsUrl', () => {
  it.each([
    ['https://api.openai.com', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com///', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/v1/chat/completions'],
    [
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
    ],
  ])('resolves %p -> %p', (input, expected) => {
    expect(resolveChatCompletionsUrl(input)).toBe(expected);
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5);
  });
  it('parses HTTP-date into seconds', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const s = parseRetryAfter(future);
    expect(s).toBeGreaterThanOrEqual(1);
    expect(s!).toBeLessThanOrEqual(6);
  });
  it('returns undefined for missing/invalid', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('OpenAIEngine.translate', () => {
  it('POSTs to resolved url with Bearer key + json body and returns content+usage', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({
        choices: [{ message: { content: '{"items":[{"id":"1","text":"你好"}]}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const engine = makeEngine({ fetchFn });

    const res = await engine.translate(baseReq);

    expect(res.content).toBe('{"items":[{"id":"1","text":"你好"}]}');
    expect(res.usage).toEqual({ inputTokens: 10, outputTokens: 5 });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, initRaw] = fetchFn.mock.calls[0]!;
    const init = initRaw as unknown as CallInit;
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.headers['Authorization']).toBe('Bearer sk-test');
    expect(init.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages).toHaveLength(2);
  });

  it('omits response_format when jsonMode is false', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ choices: [{ message: { content: '译文' } }] }),
    );
    const engine = makeEngine({ fetchFn });
    await engine.translate({ ...baseReq, jsonMode: false });
    const init = fetchFn.mock.calls[0]![1] as unknown as CallInit;
    expect(JSON.parse(init.body).response_format).toBeUndefined();
  });

  it('works against a DeepSeek-style baseUrl', async () => {
    const fetchFn = mockFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'ok' } }] }),
    );
    const engine = makeEngine({
      fetchFn,
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      provider: 'openai-compatible',
    });
    await engine.translate(baseReq);
    expect(fetchFn.mock.calls[0]![0]).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('throws EngineError (status + retryAfterSeconds) on 429', async () => {
    const fetchFn = mockFetch(() =>
      new Response('rate limited', {
        status: 429,
        headers: { 'retry-after': '5' },
      }),
    );
    const engine = makeEngine({ fetchFn });
    const err = (await rejection(engine.translate(baseReq))) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(5);
  });

  it('throws EngineError on 5xx', async () => {
    const fetchFn = mockFetch(() => new Response('boom', { status: 502 }));
    const engine = makeEngine({ fetchFn });
    const err = (await rejection(engine.translate(baseReq))) as EngineError;
    expect(err).toBeInstanceOf(EngineError);
    expect(err.status).toBe(502);
  });

  it('throws when the API key is missing (no fetch issued)', async () => {
    const fetchFn = vi.fn();
    // 直接构造无 key 引擎，绕过 makeEngine 的默认值（opts.key ?? 'sk-test'）。
    const engine = new OpenAIEngine({
      id: 'e',
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com',
      model: 'm',
      apiKeyRef: 'r',
      secretStore: fakeSecretStore(), // 无 key → getSecret 返回 undefined
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    const err = await rejection(engine.translate(baseReq));
    expect(err).toBeInstanceOf(EngineError);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('throws EngineError on network failure', async () => {
    const fetchFn = mockFetch(() => {
      throw new Error('ETIMEDOUT');
    });
    const engine = makeEngine({ fetchFn });
    const err = await rejection(engine.translate(baseReq));
    expect(err).toBeInstanceOf(EngineError);
  });
});
