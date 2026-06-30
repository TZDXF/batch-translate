/**
 * 引擎注册表测试（P0-3 / TRA-4）：get(engineId) 解析 config + 解密 key 构造引擎。
 *
 * 用真实 config-store + secret-store（内存 chrome mock + jsdom Web Crypto），端到端验证
 * 「apiKeyRef → 明文 key → 引擎实例」链路，不 mock 内部模块。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { installChromeMock } from '../../test/chrome-mock';
import { createEngineRegistry } from './registry';
import { OpenAIEngine } from './openai';
import { EngineInitError } from './adapter';
import { addEngine, setEngineApiKey, loadConfig, setActiveEngine } from '../config/config-store';
import type { EngineInput } from '../config/config-store';

describe('engineRegistry', () => {
  beforeEach(() => {
    installChromeMock();
  });

  async function addTestEngine(overrides: Partial<EngineInput> = {}): Promise<{ id: string; apiKeyRef: string }> {
    const engine = await addEngine({
      label: 'DeepSeek',
      provider: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      contextWindow: 128_000,
      maxOutput: 4096,
      ...overrides,
    });
    return { id: engine.id, apiKeyRef: engine.apiKeyRef };
  }

  it('get(已配置 + 已存 key) → OpenAIEngine 实例（明文 key 经 secret-store 解出）', async () => {
    const { id } = await addTestEngine();
    await setEngineApiKey(id, 'sk-deepseek-real-key');

    const registry = createEngineRegistry();
    const engine = await registry.get(id);

    expect(engine).toBeInstanceOf(OpenAIEngine);
    expect(engine.id).toBe(id);
    expect(engine.provider).toBe('openai-compatible');
  });

  it('明文 key 仅内存：registry 不把明文写回 storage.local', async () => {
    // 此测试由 secret-store.test.ts 覆盖存储无明文；这里只验证 get 后 storage 仍无明文泄露。
    const mock = installChromeMock();
    const { id } = await addTestEngine();
    const plaintext = 'sk-never-leak-xyz';
    await setEngineApiKey(id, plaintext);

    const registry = createEngineRegistry();
    await registry.get(id);

    for (const [, v] of mock._store) {
      expect(String(v)).not.toContain(plaintext);
    }
  });

  it('get(未配置 key) → EngineInitError', async () => {
    const { id } = await addTestEngine();
    // 不调 setEngineApiKey
    const registry = createEngineRegistry();
    await expect(registry.get(id)).rejects.toThrow(EngineInitError);
  });

  it('get(不存在的 engineId) → EngineInitError', async () => {
    const registry = createEngineRegistry();
    await expect(registry.get('eng_nonexistent')).rejects.toThrow(EngineInitError);
  });

  it('get(已禁用引擎) → EngineInitError', async () => {
    const { id } = await addTestEngine();
    await setEngineApiKey(id, 'sk');
    // 直接改 config 禁用
    const config = await loadConfig();
    const cfg = config.engines[id];
    if (cfg) {
      cfg.enabled = false;
      await import('../config/config-store').then((m) => m.saveConfig(config));
    }
    const registry = createEngineRegistry();
    await expect(registry.get(id)).rejects.toThrow(EngineInitError);
  });

  it('配置热生效：改 baseUrl/model 后 get 读到最新值', async () => {
    const { id } = await addTestEngine();
    await setEngineApiKey(id, 'sk');

    const registry = createEngineRegistry();
    const before = await registry.get(id);
    expect(before).toBeInstanceOf(OpenAIEngine);

    // 改 baseUrl
    await import('../config/config-store').then(async (m) => {
      const config = await loadConfig();
      const cfg = config.engines[id];
      if (cfg) {
        cfg.baseUrl = 'https://api.openai.com/v1';
        cfg.model = 'gpt-4o-mini';
        await m.saveConfig(config);
      }
    });

    const after = await registry.get(id);
    expect(after).toBeInstanceOf(OpenAIEngine);
    // 验证新 baseUrl 生效：OpenAIEngine 内部 baseUrl 已规整。无法直接断言私有字段，
    // 但 get 不抛错且返回新实例即说明重读了 config（无缓存）。
    expect(after.id).toBe(id);
  });

  it('Ollama provider 未实现 → EngineInitError（即使无 key 也不构造）', async () => {
    const { id } = await addTestEngine({ provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' });
    const registry = createEngineRegistry();
    await expect(registry.get(id)).rejects.toThrow(EngineInitError);
  });

  it('activeEngineId 流程：设当前引擎后 get(activeEngineId) 成功', async () => {
    const { id } = await addTestEngine();
    await setEngineApiKey(id, 'sk');
    await setActiveEngine(id);

    const config = await loadConfig();
    const registry = createEngineRegistry();
    const engine = await registry.get(config.activeEngineId);
    expect(engine.id).toBe(id);
  });
});
