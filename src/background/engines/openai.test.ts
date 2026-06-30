/**
 * OpenAI 兼容引擎测试（P0-3 / TRA-4 验收：mock fetch 验请求体构造 + json_mode + 错误/中止）。
 *
 * 不发真实网络请求；全局 fetch 被 vi.spyOn 替换为可控桩。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIEngine } from './openai';
import { EngineRequestError } from './adapter';
import type { EngineConfig } from '../../shared/types';
import type { TranslateRequest } from './adapter';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    id: 'eng-1',
    label: 'DeepSeek',
    provider: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    enabled: true,
    apiKeyRef: 'key_abc',
    contextWindow: 128_000,
    maxOutput: 4096,
    ...overrides,
  };
}

function makeReq(overrides: Partial<TranslateRequest> = {}): TranslateRequest {
  return {
    systemPrompt: 'You are a translator.',
    userMessage: '{"items":[{"id":"1","text":"hello"}]}',
    targetLang: 'zh-CN',
    jsonMode: true,
    ...overrides,
  };
}

/** 构造一个 fetch 桩，返回固定 choices/usage，并捕获调用参数。 */
function fetchOk(content: string, usage?: { prompt_tokens?: number; completion_tokens?: number }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const stub = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content } }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  });
  return { stub, calls };
}

describe('OpenAIEngine', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('构造 OpenAI 兼容请求体：POST {baseUrl}/chat/completions + Bearer + system/user 消息', async () => {
    const { stub, calls } = fetchOk('{"items":[{"id":"1","text":"你好"}]}');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), 'sk-test-123');
    const res = await engine.translate(makeReq());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(calls[0]?.init.method).toBe('POST');

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer sk-test-123');
    expect(headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are a translator.' },
      { role: 'user', content: '{"items":[{"id":"1","text":"hello"}]}' },
    ]);
    expect(body.temperature).toBe(0);
    expect(body.stream).toBe(false);
    expect(body.max_tokens).toBe(4096);

    // 响应 content 透传
    expect(res.content).toBe('{"items":[{"id":"1","text":"你好"}]}');
  });

  it('jsonMode=true 时带 response_format:{type:"json_object"}', async () => {
    const { stub, calls } = fetchOk('{}');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), 'sk-test');
    await engine.translate(makeReq({ jsonMode: true }));

    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('jsonMode=false 时不带 response_format（避免不支持端点报错）', async () => {
    const { stub, calls } = fetchOk('{}');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), 'sk-test');
    await engine.translate(makeReq({ jsonMode: false }));

    const body = JSON.parse(calls[0]?.init.body as string);
    expect(body.response_format).toBeUndefined();
  });

  it('解析 usage token 用量（prompt_tokens→inputTokens, completion_tokens→outputTokens）', async () => {
    const { stub } = fetchOk('ok', { prompt_tokens: 120, completion_tokens: 30 });
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), 'sk-test');
    const res = await engine.translate(makeReq());

    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it('usage 缺失时 res.usage 为 undefined（不报错）', async () => {
    const { stub } = fetchOk('ok');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), 'sk-test');
    const res = await engine.translate(makeReq());
    expect(res.usage).toBeUndefined();
  });

  it('baseUrl 尾斜杠被规整：不产生 //chat/completions', async () => {
    const { stub, calls } = fetchOk('ok');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig({ baseUrl: 'https://api.openai.com/v1/' }), 'sk');
    await engine.translate(makeReq());
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('key 为空时不带 Authorization 头（兼容无鉴权 endpoint）', async () => {
    const { stub, calls } = fetchOk('ok');
    vi.stubGlobal('fetch', stub);

    const engine = new OpenAIEngine(makeConfig(), '');
    await engine.translate(makeReq());
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
  });

  it('HTTP 非 2xx → 抛 EngineRequestError 含 status（供 retry 层判 429/5xx）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const engine = new OpenAIEngine(makeConfig(), 'sk');
    await expect(engine.translate(makeReq())).rejects.toMatchObject({
      name: 'EngineRequestError',
      status: 429,
    });
  });

  it('网络错（fetch reject 非 abort）→ EngineRequestError status=0（可重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('failed to fetch');
    }));

    const engine = new OpenAIEngine(makeConfig(), 'sk');
    await expect(engine.translate(makeReq())).rejects.toMatchObject({
      name: 'EngineRequestError',
      status: 0,
    });
  });

  it('AbortSignal 中止 → 原样抛 AbortError（retry 层据此不重试）', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw abortErr;
    }));

    const engine = new OpenAIEngine(makeConfig(), 'sk');
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(engine.translate(makeReq({ signal: ctrl.signal }))).rejects.toBe(abortErr);
  });

  it('响应 choices 为空 → 返回空 content（交 protocol 降级，不抛错）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    const engine = new OpenAIEngine(makeConfig(), 'sk');
    const res = await engine.translate(makeReq());
    expect(res.content).toBe('');
  });
});
