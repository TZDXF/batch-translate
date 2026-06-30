import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installChromeMock } from '../../test/chrome-mock';
import {
  addEngine,
  activeEngine,
  engineLabel,
  getDefaultConfig,
  getEngineApiKey,
  loadConfig,
  normalizeConfig,
  normalizeScheduling,
  patchConfig,
  removeEngine,
  saveConfig,
  setEngineApiKey,
  setActiveEngine,
  subscribeToConfig,
  updateEngine,
  validateEngine,
  SCHEDULING_LIMITS,
} from './config-store';
import { STORAGE_KEY_CONFIG } from '../../shared/constants';
import { __clearMasterKeyCacheForTests } from './secret-store';

describe('config-store（配置读写，架构 6.2）', () => {
  let mock: ReturnType<typeof installChromeMock>;

  beforeEach(() => {
    mock = installChromeMock();
    __clearMasterKeyCacheForTests();
  });

  describe('默认值与加载', () => {
    it('getDefaultConfig 提供完整默认 schema', () => {
      const c = getDefaultConfig();
      expect(c.version).toBe(1);
      expect(c.mode).toBe('basic');
      expect(c.sourceLang).toBe('auto');
      expect(c.scheduling.maxConcurrent).toBe(3);
      expect(c.scheduling.itemsPerBatch).toBe(20);
      expect(c.cache.enabled).toBe(true);
    });

    it('空存储 loadConfig 返回默认值', async () => {
      const c = await loadConfig();
      expect(c).toEqual(getDefaultConfig());
    });

    it('损坏数据 loadConfig 容错回退默认', async () => {
      mock._store.set(STORAGE_KEY_CONFIG, 'garbage');
      const c = await loadConfig();
      expect(c.mode).toBe('basic');
      expect(Object.keys(c.engines)).toHaveLength(0);
    });
  });

  describe('saveConfig + CONFIG_CHANGED + onChanged', () => {
    it('saveConfig 落盘并发送 CONFIG_CHANGED', async () => {
      const c = getDefaultConfig();
      c.targetLang = 'ja';
      await saveConfig(c);
      expect(mock._store.get(STORAGE_KEY_CONFIG)).toMatchObject({ targetLang: 'ja' });
      expect(mock._sentMessages).toContainEqual({ type: 'CONFIG_CHANGED' });
    });

    it('subscribeToConfig 在 storage.onChanged 时回调归一化配置', async () => {
      const cb = vi.fn();
      const unsub = subscribeToConfig(cb);
      await saveConfig({ ...getDefaultConfig(), targetLang: 'en' });
      expect(cb).toHaveBeenCalledTimes(1);
      const received = cb.mock.calls[0]![0];
      expect(received.targetLang).toBe('en');
      unsub();
      await saveConfig({ ...getDefaultConfig(), targetLang: 'de' });
      expect(cb).toHaveBeenCalledTimes(1); // 取消后不再回调
    });
  });

  describe('patchConfig', () => {
    it('局部合并各段', async () => {
      await patchConfig({ targetLang: 'fr', scheduling: { maxConcurrent: 5 } });
      const c = await loadConfig();
      expect(c.targetLang).toBe('fr');
      expect(c.scheduling.maxConcurrent).toBe(5);
      expect(c.scheduling.rps).toBe(2); // 未改字段保留默认
    });
  });

  describe('智能体模式开关 + AgentConfig（P1-1，架构 6.2）', () => {
    it('默认 mode=basic，agent 字段齐全且为安全默认', () => {
      const c = getDefaultConfig();
      expect(c.mode).toBe('basic');
      expect(c.agent).toEqual({
        systemPrompt: '',
        role: '',
        stylePreset: 'none',
        glossaryIds: [],
        pageContextEnabled: false,
      });
    });

    it('patchConfig 切换 agentMode 开关 + 局部合并 agent 字段', async () => {
      await patchConfig({
        mode: 'agent',
        agent: { role: '法律译者', stylePreset: 'literary', glossaryIds: ['g1'] },
      });
      const c = await loadConfig();
      expect(c.mode).toBe('agent');
      expect(c.agent.role).toBe('法律译者');
      expect(c.agent.stylePreset).toBe('literary');
      expect(c.agent.glossaryIds).toEqual(['g1']);
      // 未改字段保留默认
      expect(c.agent.systemPrompt).toBe('');
      expect(c.agent.pageContextEnabled).toBe(false);
    });

    it('normalizeConfig 容错非法 agent 字段（非法 stylePreset 回退 none、glossaryIds 过滤非字符串）', () => {
      const c = normalizeConfig({
        mode: 'agent',
        agent: {
          systemPrompt: '自定义',
          role: 'r',
          stylePreset: 'bogus',
          glossaryIds: ['g1', 9 as unknown as string, null as unknown as string],
          pageContextEnabled: 'yes' as unknown as boolean,
        },
      });
      expect(c.mode).toBe('agent');
      expect(c.agent.systemPrompt).toBe('自定义');
      expect(c.agent.stylePreset).toBe('none');
      expect(c.agent.glossaryIds).toEqual(['g1']);
      expect(c.agent.pageContextEnabled).toBe(false);
    });

    it('normalizeConfig 非法 mode 回退 basic（开关默认关闭，零回归）', () => {
      const c = normalizeConfig({ mode: 'weird' as unknown as string });
      expect(c.mode).toBe('basic');
    });
  });

  describe('normalizeScheduling 钳制（架构 5.3 范围）', () => {
    it('超出范围钳制到边界', () => {
      const s = normalizeScheduling({
        maxConcurrent: 999,
        rps: 0,
        itemsPerBatch: 1000,
        maxRetries: -1,
        batchTokenBudgetRatio: 5,
        tpmLimit: -10,
      });
      expect(s.maxConcurrent).toBe(SCHEDULING_LIMITS.maxConcurrent.max);
      expect(s.rps).toBe(SCHEDULING_LIMITS.rps.min);
      expect(s.itemsPerBatch).toBe(SCHEDULING_LIMITS.itemsPerBatch.max);
      expect(s.maxRetries).toBe(SCHEDULING_LIMITS.maxRetries.min);
      expect(s.batchTokenBudgetRatio).toBe(SCHEDULING_LIMITS.batchTokenBudgetRatio.max);
      expect(s.tpmLimit).toBe(0);
    });
    it('undefined 字段回退默认', () => {
      const s = normalizeScheduling({});
      expect(s).toEqual(getDefaultConfig().scheduling);
    });
  });

  describe('引擎 CRUD + 密钥', () => {
    it('addEngine 分配 id/apiKeyRef 并设为首个激活引擎', async () => {
      const eng = await addEngine({
        label: 'DeepSeek',
        provider: 'openai-compatible',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        contextWindow: 64000,
        maxOutput: 4096,
      });
      expect(eng.id).toMatch(/^eng_/);
      expect(eng.apiKeyRef).toMatch(/^key_/);
      const c = await loadConfig();
      expect(c.engines[eng.id]).toBeDefined();
      expect(c.activeEngineId).toBe(eng.id);
    });

    it('setEngineApiKey/getEngineApiKey 加密往返（config 不存明文）', async () => {
      const eng = await addEngine({
        label: 'OpenAI',
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-4o-mini',
        contextWindow: 128000,
        maxOutput: 4096,
      });
      await setEngineApiKey(eng.id, 'sk-test-123');
      expect(await getEngineApiKey(eng.id)).toBe('sk-test-123');
      // config 落盘内容不含明文。
      const stored = JSON.stringify(mock._store.get(STORAGE_KEY_CONFIG));
      expect(stored).not.toContain('sk-test-123');
    });

    it('updateEngine 更新非密钥字段', async () => {
      const eng = await addEngine({
        label: 'A', provider: 'openai-compatible', baseUrl: 'https://x/v1',
        model: 'm', contextWindow: 32000, maxOutput: 2048,
      });
      await updateEngine(eng.id, { label: 'B', enabled: false });
      const c = await loadConfig();
      expect(c.engines[eng.id]!.label).toBe('B');
      expect(c.engines[eng.id]!.enabled).toBe(false);
    });

    it('removeEngine 连同密钥清除；激活引擎回退到首个', async () => {
      const e1 = await addEngine({ label: 'A', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b', contextWindow: 32000, maxOutput: 2048 });
      const e2 = await addEngine({ label: 'B', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b', contextWindow: 32000, maxOutput: 2048 });
      await setEngineApiKey(e1.id, 'k1');
      await setActiveEngine(e1.id);
      await removeEngine(e1.id);
      const c = await loadConfig();
      expect(c.engines[e1.id]).toBeUndefined();
      expect(c.activeEngineId).toBe(e2.id);
      expect(await getEngineApiKey(e1.id)).toBeNull(); // 密钥已删
    });

    it('setActiveEngine 切换激活引擎', async () => {
      const e1 = await addEngine({ label: 'A', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'm', contextWindow: 32000, maxOutput: 2048 });
      const e2 = await addEngine({ label: 'B', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'm', contextWindow: 32000, maxOutput: 2048 });
      await setActiveEngine(e2.id);
      expect((await loadConfig()).activeEngineId).toBe(e2.id);
      expect(activeEngine(await loadConfig())?.id).toBe(e2.id);
    });

    it('删除最后一个引擎时 activeEngineId 清空', async () => {
      const e1 = await addEngine({ label: 'A', provider: 'ollama', baseUrl: 'http://localhost:11434', model: 'm', contextWindow: 32000, maxOutput: 2048 });
      await removeEngine(e1.id);
      expect((await loadConfig()).activeEngineId).toBe('');
      expect(engineLabel(activeEngine(await loadConfig()))).toBe('未配置引擎');
    });
  });

  describe('validateEngine', () => {
    it('缺 label/baseUrl/model 报错（Ollama baseUrl 可空）', () => {
      expect(validateEngine({})).toContain('label 不能为空');
      expect(validateEngine({ label: 'x', provider: 'openai' })).toContain('baseUrl 不能为空（Ollama 除外）');
      expect(validateEngine({ label: 'x', provider: 'ollama', model: 'm' })).toHaveLength(0);
    });
  });
});
