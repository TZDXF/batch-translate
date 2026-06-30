/**
 * 引擎适配层工厂测试（P0-3 / TRA-4）：createEngine 按 provider 分发 + 未实现 provider 抛错。
 */
import { describe, it, expect } from 'vitest';
import { createEngine, EngineInitError } from './adapter';
import { OpenAIEngine } from './openai';
import type { EngineConfig } from '../../shared/types';

function cfg(provider: EngineConfig['provider'], overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    id: 'e1',
    label: 'e',
    provider,
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    enabled: true,
    apiKeyRef: 'key_x',
    contextWindow: 128_000,
    maxOutput: 4096,
    ...overrides,
  };
}

describe('createEngine factory', () => {
  it('openai provider → OpenAIEngine 实例', () => {
    const e = createEngine({ config: cfg('openai'), apiKey: 'sk' });
    expect(e).toBeInstanceOf(OpenAIEngine);
    expect(e.provider).toBe('openai');
    expect(e.id).toBe('e1');
  });

  it('openai-compatible provider → OpenAIEngine（共用 OpenAI 兼容实现）', () => {
    const e = createEngine({ config: cfg('openai-compatible', { baseUrl: 'https://api.deepseek.com/v1' }), apiKey: 'sk' });
    expect(e).toBeInstanceOf(OpenAIEngine);
    expect(e.provider).toBe('openai-compatible');
  });

  it('anthropic / gemini / ollama → EngineInitError（P1 范围，未实现）', () => {
    for (const p of ['anthropic', 'gemini', 'ollama'] as const) {
      expect(() => createEngine({ config: cfg(p), apiKey: 'sk' })).toThrow(EngineInitError);
    }
  });

  it('未知 provider → EngineInitError', () => {
    expect(() => createEngine({ config: cfg('openai', { provider: 'grok' as unknown as EngineConfig['provider'] }), apiKey: 'sk' })).toThrow(EngineInitError);
  });
});
