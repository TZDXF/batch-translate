import { describe, it, expect } from 'vitest';
import { createEngineRegistry } from '../engines/registry';
import { OpenAIEngine } from '../engines/openai';
import type { EngineConfig, EngineProvider } from '../engines/adapter';
import { fakeSecretStore } from './helpers';

/** 构造一个完整 EngineConfig（shared 类型要求 label/enabled/contextWindow/maxOutput 必填）。 */
function cfg(over: Partial<EngineConfig> = {}): EngineConfig {
  return {
    id: 'e1',
    label: 'test',
    provider: 'openai-compatible',
    baseUrl: 'https://api.openai.com',
    model: 'gpt-4o-mini',
    enabled: true,
    apiKeyRef: 'ref1',
    contextWindow: 128_000,
    maxOutput: 4_096,
    ...over,
  };
}

describe('createEngineRegistry', () => {
  it('instantiates openai and openai-compatible engines', () => {
    const reg = createEngineRegistry(
      [
        cfg({ id: 'a', provider: 'openai' }),
        cfg({ id: 'b', provider: 'openai-compatible' }),
      ],
      { secretStore: fakeSecretStore() },
    );
    expect(reg.has('a')).toBe(true);
    expect(reg.has('b')).toBe(true);
    expect(reg.get('a')).toBeInstanceOf(OpenAIEngine);
    expect(reg.get('b')).toBeInstanceOf(OpenAIEngine);
    expect(reg.list()).toHaveLength(2);
  });

  it('skips engines with enabled=false', () => {
    const reg = createEngineRegistry(
      [cfg({ id: 'a' }), cfg({ id: 'b', enabled: false })],
      { secretStore: fakeSecretStore() },
    );
    expect(reg.list()).toHaveLength(1);
    expect(reg.has('b')).toBe(false);
  });

  it('get returns undefined for an unknown id', () => {
    const reg = createEngineRegistry([cfg({ id: 'a' })], {
      secretStore: fakeSecretStore(),
    });
    expect(reg.get('nope')).toBeUndefined();
  });

  it('throws on duplicate engine id', () => {
    expect(() =>
      createEngineRegistry([cfg({ id: 'a' }), cfg({ id: 'a' })], {
        secretStore: fakeSecretStore(),
      }),
    ).toThrow(/duplicate engine id/);
  });

  it('throws P1 not-implemented for anthropic/gemini/ollama', () => {
    const providers: EngineProvider[] = ['anthropic', 'gemini', 'ollama'];
    for (const provider of providers) {
      expect(() =>
        createEngineRegistry([cfg({ id: provider, provider })], {
          secretStore: fakeSecretStore(),
        }),
      ).toThrow(/not implemented/);
    }
  });

  it('resolves the API key lazily at translate time (instantiation needs no key)', async () => {
    // secretStore 默认无 key
    const reg = createEngineRegistry([cfg({ id: 'a' })], {
      secretStore: fakeSecretStore(),
    });
    const engine = reg.get('a');
    expect(engine).toBeInstanceOf(OpenAIEngine);
    // 无 key + 无 fetchFn -> 应在取 key 阶段抛 EngineError，证明 key 延迟到 translate 才解析。
    await expect(
      engine!.translate({
        systemPrompt: '',
        userMessage: '',
        targetLang: 'zh',
        jsonMode: true,
      }),
    ).rejects.toBeInstanceOf(Error);
  });
});
