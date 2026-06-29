import { describe, it, expect } from 'vitest';
import {
  RUNTIME_MESSAGE_TYPE,
  PORT_MESSAGE_TYPE,
  isRuntimeMessage,
  isPortMessage,
  classifyMessage,
  isGetStatus,
  isToggleTranslate,
  isSwitchEngine,
  isSwitchMode,
  isGetConfig,
  isConfigChanged,
  isStatus,
  isConfig,
  isTranslateBatch,
  isCancel,
  isProgress,
  isResult,
  isError,
  isBatchDone,
  isStreamChunk,
  assertNeverType,
  type RuntimeMessage,
  type PortMessage,
} from '../messages';
import {
  translatePortName,
  parseTranslatePortName,
  TRANSLATE_PORT_PREFIX,
  ENGINE_PROVIDERS,
  DEFAULT_SCHEDULING,
  MAX_ITEMS_PER_BATCH,
} from '../constants';
import type { AppConfig, EngineProvider } from '../types';

/** 构造一份合法的完整配置样本。 */
function makeConfig(): AppConfig {
  return {
    version: 1,
    engines: {},
    activeEngineId: '',
    targetLang: 'zh',
    sourceLang: 'auto',
    mode: 'basic',
    agent: {
      systemPrompt: '',
      role: '',
      stylePreset: 'none',
      glossaryIds: [],
      pageContextEnabled: false,
    },
    scheduling: { ...DEFAULT_SCHEDULING },
    cache: { enabled: true, maxSizeMB: 100, ttlDays: 0 },
    ui: { showOriginal: true, translationStyle: '', hoverOnly: false },
  };
}

/** 合法的一次性消息样本（每个 union 成员恰好一个）。 */
const runtimeSamples: RuntimeMessage[] = [
  { type: 'GET_STATUS', tabId: 1 },
  { type: 'TOGGLE_TRANSLATE', tabId: 1, on: true },
  { type: 'SWITCH_ENGINE', engineId: 'openai-1' },
  { type: 'SWITCH_MODE', mode: 'agent' },
  { type: 'GET_CONFIG' },
  { type: 'CONFIG_CHANGED' },
  { type: 'STATUS', tabId: 1, state: 'translating', progress: 0.5 },
  { type: 'CONFIG', config: makeConfig() },
];

/** 合法的 Port 消息样本（每个 union 成员恰好一个）。 */
const portSamples: PortMessage[] = [
  { type: 'TRANSLATE_BATCH', items: [{ id: '1', text: 'hi' }] },
  { type: 'CANCEL' },
  { type: 'PROGRESS', id: '1', status: 'translating' },
  { type: 'RESULT', id: '1', translated: '你好' },
  { type: 'ERROR', id: '1', reason: 'rate limited (429)' },
  { type: 'BATCH_DONE', batchId: 'b1' },
  { type: 'STREAM_CHUNK', id: '1', chunk: '你' },
];

// ── exhaustive switch：缺 case 时 default 的 m 不再是 never → TS 编译报错 ──
function exhaustRuntime(m: RuntimeMessage): string {
  switch (m.type) {
    case 'GET_STATUS': return `status:${m.tabId}`;
    case 'TOGGLE_TRANSLATE': return `toggle:${m.on ? 'on' : 'off'}`;
    case 'SWITCH_ENGINE': return `engine:${m.engineId}`;
    case 'SWITCH_MODE': return `mode:${m.mode}`;
    case 'GET_CONFIG': return 'get-config';
    case 'CONFIG_CHANGED': return 'changed';
    case 'STATUS': return `${m.state}:${m.progress}`;
    case 'CONFIG': return `cfg:v${m.config.version}`;
    default: return assertNeverType(m);
  }
}

function exhaustPort(m: PortMessage): string {
  switch (m.type) {
    case 'TRANSLATE_BATCH': return `batch:${m.items.length}`;
    case 'CANCEL': return 'cancel';
    case 'PROGRESS': return `progress:${m.status}`;
    case 'RESULT': return `result:${m.translated}`;
    case 'ERROR': return `error:${m.reason}`;
    case 'BATCH_DONE': return `done:${m.batchId}`;
    case 'STREAM_CHUNK': return `chunk:${m.chunk}`;
    default: return assertNeverType(m);
  }
}

describe('shared/messages — type 字符串集合', () => {
  it('RUNTIME_MESSAGE_TYPE 数量与样本一致且无重复', () => {
    const types = Object.values(RUNTIME_MESSAGE_TYPE);
    expect(types).toHaveLength(runtimeSamples.length);
    expect(new Set(types).size).toBe(types.length);
  });

  it('PORT_MESSAGE_TYPE 数量与样本一致且无重复', () => {
    const types = Object.values(PORT_MESSAGE_TYPE);
    expect(types).toHaveLength(portSamples.length);
    expect(new Set(types).size).toBe(types.length);
  });

  it('两个 union 的 type 取值不相交', () => {
    const rt = new Set<string>(Object.values(RUNTIME_MESSAGE_TYPE));
    for (const t of Object.values(PORT_MESSAGE_TYPE)) {
      expect(rt.has(t)).toBe(false);
    }
  });

  it('每个样本的 type 落在对应常量集合内', () => {
    const rt = new Set<string>(Object.values(RUNTIME_MESSAGE_TYPE));
    const pt = new Set<string>(Object.values(PORT_MESSAGE_TYPE));
    for (const s of runtimeSamples) expect(rt.has(s.type)).toBe(true);
    for (const s of portSamples) expect(pt.has(s.type)).toBe(true);
  });
});

describe('shared/messages — 守卫', () => {
  it('isRuntimeMessage 接受全部一次性样本，拒绝全部 Port 样本', () => {
    for (const s of runtimeSamples) expect(isRuntimeMessage(s)).toBe(true);
    for (const s of portSamples) expect(isRuntimeMessage(s)).toBe(false);
  });

  it('isPortMessage 接受全部 Port 样本，拒绝全部一次性样本', () => {
    for (const s of portSamples) expect(isPortMessage(s)).toBe(true);
    for (const s of runtimeSamples) expect(isPortMessage(s)).toBe(false);
  });

  it('classifyMessage 正确归类 runtime / port / null', () => {
    for (const s of runtimeSamples) expect(classifyMessage(s)).toBe('runtime');
    for (const s of portSamples) expect(classifyMessage(s)).toBe('port');
  });

  it('拒绝非法输入（非对象或 type 不合法）', () => {
    // 守卫只判别 discriminant type 字段；载荷校验属调用方职责。
    const clearlyInvalid: unknown[] = [
      null,
      undefined,
      {},
      { type: 'NOPE' },
      { type: 123 },
      'GET_STATUS',
      42,
    ];
    for (const bad of clearlyInvalid) {
      expect(isRuntimeMessage(bad)).toBe(false);
      expect(isPortMessage(bad)).toBe(false);
      expect(classifyMessage(bad)).toBe(null);
    }
  });
});

describe('shared/messages — 单 type 守卫收窄', () => {
  it('收窄后可访问成员专属载荷字段', () => {
    const m: RuntimeMessage = { type: 'TOGGLE_TRANSLATE', tabId: 7, on: false };
    if (!isToggleTranslate(m)) throw new Error('should narrow');
    // on 仅 TOGGLE_TRANSLATE 成员存在
    expect(m.on).toBe(false);
    expect(m.tabId).toBe(7);

    const p: PortMessage = { type: 'RESULT', id: '9', translated: '嗨' };
    if (!isResult(p)) throw new Error('should narrow');
    expect(p.translated).toBe('嗨');
  });

  it('单 type 守卫一一匹配', () => {
    expect(isGetStatus({ type: 'GET_STATUS', tabId: 1 })).toBe(true);
    expect(isGetStatus({ type: 'GET_CONFIG' })).toBe(false);
    expect(isSwitchEngine({ type: 'SWITCH_ENGINE', engineId: 'e' })).toBe(true);
    expect(isSwitchMode({ type: 'SWITCH_MODE', mode: 'agent' })).toBe(true);
    expect(isGetConfig({ type: 'GET_CONFIG' })).toBe(true);
    expect(isConfigChanged({ type: 'CONFIG_CHANGED' })).toBe(true);
    expect(isStatus({ type: 'STATUS', tabId: 1, state: 'idle', progress: 0 })).toBe(true);
    expect(isConfig({ type: 'CONFIG', config: makeConfig() })).toBe(true);

    expect(isTranslateBatch({ type: 'TRANSLATE_BATCH', items: [] })).toBe(true);
    expect(isCancel({ type: 'CANCEL' })).toBe(true);
    expect(isProgress({ type: 'PROGRESS', id: '1', status: 'done' })).toBe(true);
    expect(isError({ type: 'ERROR', id: '1', reason: 'x' })).toBe(true);
    expect(isBatchDone({ type: 'BATCH_DONE', batchId: 'b' })).toBe(true);
    expect(isStreamChunk({ type: 'STREAM_CHUNK', id: '1', chunk: 'c' })).toBe(true);
  });
});

describe('shared/messages — exhaustive switch（编译期 union 完整性）', () => {
  it('一次性消息 switch 覆盖全部成员', () => {
    for (const s of runtimeSamples) {
      expect(typeof exhaustRuntime(s)).toBe('string');
    }
  });

  it('Port 消息 switch 覆盖全部成员', () => {
    for (const s of portSamples) {
      expect(typeof exhaustPort(s)).toBe('string');
    }
  });
});

describe('shared/constants', () => {
  it('ENGINE_PROVIDERS 与 EngineProvider 类型一一对应', () => {
    expect(new Set(ENGINE_PROVIDERS)).toEqual(
      new Set<EngineProvider>(['openai', 'anthropic', 'gemini', 'ollama', 'openai-compatible']),
    );
  });

  it('默认调度参数对齐架构 5.3', () => {
    expect(DEFAULT_SCHEDULING.maxConcurrent).toBe(3);
    expect(DEFAULT_SCHEDULING.rps).toBe(2);
    expect(DEFAULT_SCHEDULING.tpmLimit).toBe(0);
    expect(DEFAULT_SCHEDULING.maxRetries).toBe(5);
    expect(DEFAULT_SCHEDULING.itemsPerBatch).toBe(20);
    expect(DEFAULT_SCHEDULING.batchTokenBudgetRatio).toBe(0.7);
    expect(MAX_ITEMS_PER_BATCH).toBe(20);
  });

  it('translatePortName / parseTranslatePortName 往返与边界', () => {
    expect(translatePortName(42)).toBe(`${TRANSLATE_PORT_PREFIX}42`);
    expect(parseTranslatePortName(translatePortName(42))).toBe(42);
    expect(parseTranslatePortName('translate:1')).toBe(1);
    // 非翻译 Port
    expect(parseTranslatePortName('other:1')).toBeUndefined();
    // 非正整数
    expect(parseTranslatePortName('translate:0')).toBeUndefined();
    expect(parseTranslatePortName('translate:abc')).toBeUndefined();
    expect(parseTranslatePortName('translate:-3')).toBeUndefined();
  });
});
