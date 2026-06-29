/**
 * 配置读写（架构 6.2）。
 *
 * 单一配置根存 storage.local[STORAGE_KEY_CONFIG]（架构 6.2 `config` 键）。本模块是其
 * 唯一读写入口：默认值、加载（容错合并）、校验、引擎 CRUD、跨上下文订阅、配置变更通知。
 *
 * 双向绑定（任务交付物 #4）：options 页编辑 → saveConfig 落盘 → notifyConfigChanged 触发
 * SW 重载（CONFIG_CHANGED）；任意上下文写盘 → chrome.storage.onChanged → 其他上下文
 * （options/popup/SW）订阅即获新值。API Key 仅以 apiKeyRef（引用 id）入 config，明文走
 * secret-store，绝不进 storage.sync（架构 6.2 / 7.2）。
 *
 * 本模块刻意不引 Preact/Signals —— 保持纯逻辑可单测；options/popup 侧各自用 signal 镜像。
 */
import type {
  AgentConfig,
  AppConfig,
  CacheConfig,
  EngineConfig,
  EngineProvider,
  SchedulingConfig,
  TranslateMode,
  UIConfig,
} from '../../shared/types';
import {
  CACHE_DEFAULT_MAX_SIZE_MB,
  DEFAULT_SCHEDULING,
  MAX_ITEMS_PER_BATCH,
  STORAGE_KEY_CONFIG,
} from '../../shared/constants';
import {
  deleteSecret,
  generateSecretRef,
  getSecret,
  setSecret,
} from './secret-store';

/** config.version（架构 6.2）。schema 演进时递增，normalizeConfig 据此迁移。 */
export const CONFIG_VERSION = 1;

/** 默认目标语言（项目面向中文用户）。源语言默认 auto。 */
export const DEFAULT_TARGET_LANG = 'zh-CN';

/**
 * provider 预设（UI 便利 + 校验参考）。baseUrl 为官方默认，用户可改。
 * openai-compatible 留空 baseUrl，强制用户填写（通用 OpenAI 兼容 endpoint）。
 */
export const PROVIDER_PRESETS: Record<EngineProvider, { baseUrl: string; model: string }> = {
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { baseUrl: 'https://api.anthropic.com/v1', model: 'claude-3-5-sonnet-latest' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-1.5-flash' },
  ollama: { baseUrl: 'http://localhost:11434', model: 'qwen2.5:7b' },
  'openai-compatible': { baseUrl: '', model: '' },
};

/** 调度参数范围（架构 5.3）。validateScheduling 据此钳制并报错。 */
export const SCHEDULING_LIMITS = {
  maxConcurrent: { min: 1, max: 10 },
  rps: { min: 0.1, max: 50 },
  tpmLimit: { min: 0, max: 10_000_000 },
  maxRetries: { min: 0, max: 10 },
  itemsPerBatch: { min: 1, max: MAX_ITEMS_PER_BATCH },
  batchTokenBudgetRatio: { min: 0.1, max: 0.95 },
} as const;

// ─── 默认配置 ──────────────────────────────────────────────────────────────
export function getDefaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    engines: {},
    activeEngineId: '',
    targetLang: DEFAULT_TARGET_LANG,
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
    cache: { enabled: true, maxSizeMB: CACHE_DEFAULT_MAX_SIZE_MB, ttlDays: 0 },
    ui: { showOriginal: true, translationStyle: 'default', hoverOnly: false },
  };
}

// ─── 归一化 / 容错合并 ─────────────────────────────────────────────────────
function clampNum(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : fallback;
  return Math.min(max, Math.max(min, v));
}

/** 把未知来源（storage / onChanged / patch）归一化为合法 SchedulingConfig。 */
export function normalizeScheduling(raw: Partial<SchedulingConfig> | undefined): SchedulingConfig {
  const base = { ...DEFAULT_SCHEDULING, ...raw };
  return {
    maxConcurrent: Math.round(clampNum(base.maxConcurrent, SCHEDULING_LIMITS.maxConcurrent.min, SCHEDULING_LIMITS.maxConcurrent.max, DEFAULT_SCHEDULING.maxConcurrent)),
    rps: clampNum(base.rps, SCHEDULING_LIMITS.rps.min, SCHEDULING_LIMITS.rps.max, DEFAULT_SCHEDULING.rps),
    tpmLimit: Math.round(clampNum(base.tpmLimit, SCHEDULING_LIMITS.tpmLimit.min, SCHEDULING_LIMITS.tpmLimit.max, DEFAULT_SCHEDULING.tpmLimit)),
    maxRetries: Math.round(clampNum(base.maxRetries, SCHEDULING_LIMITS.maxRetries.min, SCHEDULING_LIMITS.maxRetries.max, DEFAULT_SCHEDULING.maxRetries)),
    itemsPerBatch: Math.round(clampNum(base.itemsPerBatch, SCHEDULING_LIMITS.itemsPerBatch.min, SCHEDULING_LIMITS.itemsPerBatch.max, DEFAULT_SCHEDULING.itemsPerBatch)),
    batchTokenBudgetRatio: clampNum(base.batchTokenBudgetRatio, SCHEDULING_LIMITS.batchTokenBudgetRatio.min, SCHEDULING_LIMITS.batchTokenBudgetRatio.max, DEFAULT_SCHEDULING.batchTokenBudgetRatio),
  };
}

/** 把未知对象归一化为合法 AppConfig（容错：缺字段补默认、非法字段钳制）。 */
export function normalizeConfig(raw: unknown): AppConfig {
  const def = getDefaultConfig();
  if (typeof raw !== 'object' || raw === null) return def;
  const r = raw as Record<string, unknown>;

  const engines: Record<string, EngineConfig> = {};
  const rawEngines = r['engines'];
  if (typeof rawEngines === 'object' && rawEngines !== null) {
    for (const [id, val] of Object.entries(rawEngines as Record<string, unknown>)) {
      if (typeof val === 'object' && val !== null) {
        const e = val as Record<string, unknown>;
        engines[id] = {
          id: typeof e['id'] === 'string' ? e['id'] : id,
          label: typeof e['label'] === 'string' ? e['label'] : id,
          provider: (typeof e['provider'] === 'string' ? e['provider'] : 'openai-compatible') as EngineProvider,
          baseUrl: typeof e['baseUrl'] === 'string' ? e['baseUrl'] : '',
          model: typeof e['model'] === 'string' ? e['model'] : '',
          enabled: typeof e['enabled'] === 'boolean' ? e['enabled'] : true,
          apiKeyRef: typeof e['apiKeyRef'] === 'string' ? e['apiKeyRef'] : '',
          contextWindow: clampNum(e['contextWindow'], 1024, 2_000_000, 128_000),
          maxOutput: clampNum(e['maxOutput'], 256, 1_000_000, 4096),
        };
      }
    }
  }

  const agentSrc = (typeof r['agent'] === 'object' && r['agent'] !== null ? r['agent'] : {}) as Record<string, unknown>;
  const agent: AgentConfig = {
    systemPrompt: typeof agentSrc['systemPrompt'] === 'string' ? agentSrc['systemPrompt'] : def.agent.systemPrompt,
    role: typeof agentSrc['role'] === 'string' ? agentSrc['role'] : def.agent.role,
    stylePreset: (typeof agentSrc['stylePreset'] === 'string' ? agentSrc['stylePreset'] : 'none') as AgentConfig['stylePreset'],
    glossaryIds: Array.isArray(agentSrc['glossaryIds']) ? (agentSrc['glossaryIds'] as string[]).filter((x) => typeof x === 'string') : [],
    pageContextEnabled: typeof agentSrc['pageContextEnabled'] === 'boolean' ? agentSrc['pageContextEnabled'] : false,
  };

  const cacheSrc = (typeof r['cache'] === 'object' && r['cache'] !== null ? r['cache'] : {}) as Record<string, unknown>;
  const cache: CacheConfig = {
    enabled: typeof cacheSrc['enabled'] === 'boolean' ? cacheSrc['enabled'] : def.cache.enabled,
    maxSizeMB: Math.round(clampNum(cacheSrc['maxSizeMB'], 1, 10_000, CACHE_DEFAULT_MAX_SIZE_MB)),
    ttlDays: Math.round(clampNum(cacheSrc['ttlDays'], 0, 3650, 0)),
  };

  const uiSrc = (typeof r['ui'] === 'object' && r['ui'] !== null ? r['ui'] : {}) as Record<string, unknown>;
  const ui: UIConfig = {
    showOriginal: typeof uiSrc['showOriginal'] === 'boolean' ? uiSrc['showOriginal'] : def.ui.showOriginal,
    translationStyle: typeof uiSrc['translationStyle'] === 'string' ? uiSrc['translationStyle'] : def.ui.translationStyle,
    hoverOnly: typeof uiSrc['hoverOnly'] === 'boolean' ? uiSrc['hoverOnly'] : def.ui.hoverOnly,
  };

  const activeEngineId = typeof r['activeEngineId'] === 'string' ? r['activeEngineId'] : def.activeEngineId;

  return {
    version: CONFIG_VERSION,
    engines,
    activeEngineId: activeEngineId in engines ? activeEngineId : def.activeEngineId,
    targetLang: typeof r['targetLang'] === 'string' && r['targetLang'] ? r['targetLang'] : def.targetLang,
    sourceLang: typeof r['sourceLang'] === 'string' ? r['sourceLang'] : def.sourceLang,
    mode: r['mode'] === 'agent' ? 'agent' : 'basic',
    agent,
    scheduling: normalizeScheduling((typeof r['scheduling'] === 'object' && r['scheduling'] !== null ? r['scheduling'] : {}) as Partial<SchedulingConfig>),
    cache,
    ui,
  };
}

// ─── 读写 ──────────────────────────────────────────────────────────────────
/** 加载配置（缺省/损坏回退默认并合并）。 */
export async function loadConfig(): Promise<AppConfig> {
  const rec = await chrome.storage.local.get(STORAGE_KEY_CONFIG);
  return normalizeConfig(rec[STORAGE_KEY_CONFIG]);
}

/** 全量写盘 + 通知 SW 重载。 */
export async function saveConfig(config: AppConfig): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY_CONFIG]: config });
  await notifyConfigChanged();
}

/** 配置变更通知 SW（架构 2.2 options→SW CONFIG_CHANGED）。SW 不可达时静默。 */
export async function notifyConfigChanged(): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: 'CONFIG_CHANGED' });
  } catch {
    /* SW 未就绪/storage.onChanged 仍会广播给其他上下文 */
  }
}

/** 局部更新片段：各子段支持 Partial（仅 scheduling/cache/agent/ui 局部合并）。 */
export interface ConfigPatch {
  activeEngineId?: string;
  targetLang?: string;
  sourceLang?: 'auto' | string;
  mode?: TranslateMode;
  agent?: Partial<AgentConfig>;
  scheduling?: Partial<SchedulingConfig>;
  cache?: Partial<CacheConfig>;
  ui?: Partial<UIConfig>;
}

/** 局部更新（合并各段后落盘 + 通知）。返回写回后的完整配置。 */
export async function patchConfig(patch: ConfigPatch): Promise<AppConfig> {
  const cur = await loadConfig();
  const next: AppConfig = {
    ...cur,
    ...(patch.targetLang !== undefined ? { targetLang: patch.targetLang } : {}),
    ...(patch.sourceLang !== undefined ? { sourceLang: patch.sourceLang } : {}),
    ...(patch.mode !== undefined ? { mode: patch.mode } : {}),
    ...(patch.activeEngineId !== undefined ? { activeEngineId: patch.activeEngineId } : {}),
    scheduling: normalizeScheduling({ ...cur.scheduling, ...(patch.scheduling ?? {}) }),
    cache: { ...cur.cache, ...(patch.cache ?? {}) },
    agent: { ...cur.agent, ...(patch.agent ?? {}) },
    ui: { ...cur.ui, ...(patch.ui ?? {}) },
  };
  await saveConfig(next);
  return next;
}

// ─── 跨上下文订阅（chrome.storage.onChanged） ─────────────────────────────
/** 订阅配置变更，返回取消订阅函数。 */
export function subscribeToConfig(cb: (config: AppConfig) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== 'local') return;
    const change = changes[STORAGE_KEY_CONFIG];
    if (!change) return;
    cb(normalizeConfig(change.newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

// ─── 引擎 CRUD ─────────────────────────────────────────────────────────────
export interface EngineInput {
  label: string;
  provider: EngineProvider;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
  enabled?: boolean;
}

export function validateEngine(input: Partial<EngineInput>): string[] {
  const errors: string[] = [];
  if (!input.label || !input.label.trim()) errors.push('label 不能为空');
  if (!input.provider) errors.push('provider 不能为空');
  if (input.provider !== 'ollama' && (!input.baseUrl || !input.baseUrl.trim())) {
    errors.push('baseUrl 不能为空（Ollama 除外）');
  }
  if (!input.model || !input.model.trim()) errors.push('model 不能为空');
  return errors;
}

/** 新增引擎：分配 id + apiKeyRef（密钥引用），不存明文。 */
export async function addEngine(input: EngineInput): Promise<EngineConfig> {
  const config = await loadConfig();
  const id = `eng_${generateId()}`;
  const engine: EngineConfig = {
    id,
    label: input.label.trim(),
    provider: input.provider,
    baseUrl: input.baseUrl.trim(),
    model: input.model.trim(),
    enabled: input.enabled ?? true,
    apiKeyRef: generateSecretRef(),
    contextWindow: Math.round(input.contextWindow),
    maxOutput: Math.round(input.maxOutput),
  };
  config.engines[id] = engine;
  if (!config.activeEngineId) config.activeEngineId = id;
  await saveConfig(config);
  return engine;
}

/** 更新引擎非密钥字段。 */
export async function updateEngine(id: string, patch: Partial<Omit<EngineInput, 'apiKeyRef'>>): Promise<void> {
  const config = await loadConfig();
  const cur = config.engines[id];
  if (!cur) throw new Error(`引擎不存在: ${id}`);
  config.engines[id] = {
    ...cur,
    ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
    ...(patch.provider !== undefined ? { provider: patch.provider } : {}),
    ...(patch.baseUrl !== undefined ? { baseUrl: patch.baseUrl.trim() } : {}),
    ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    ...(patch.contextWindow !== undefined ? { contextWindow: Math.round(patch.contextWindow) } : {}),
    ...(patch.maxOutput !== undefined ? { maxOutput: Math.round(patch.maxOutput) } : {}),
  };
  await saveConfig(config);
}

/** 设置/重置引擎 API Key（加密落盘 secret-store，config 只存引用）。 */
export async function setEngineApiKey(id: string, plaintext: string): Promise<void> {
  const config = await loadConfig();
  const engine = config.engines[id];
  if (!engine) throw new Error(`引擎不存在: ${id}`);
  if (!engine.apiKeyRef) {
    // 兼容旧数据：补一个引用 id 并落盘。
    engine.apiKeyRef = generateSecretRef();
    await saveConfig(config);
  }
  await setSecret(engine.apiKeyRef, plaintext);
}

/** 读取引擎 API Key 明文（仅内存使用，引擎适配层调用）。 */
export async function getEngineApiKey(id: string): Promise<string | null> {
  const config = await loadConfig();
  const engine = config.engines[id];
  if (!engine || !engine.apiKeyRef) return null;
  return getSecret(engine.apiKeyRef);
}

/** 删除引擎：连同其密钥一并清除；若是当前激活引擎则清空 activeEngineId。 */
export async function removeEngine(id: string): Promise<void> {
  const config = await loadConfig();
  const engine = config.engines[id];
  if (!engine) return;
  if (engine.apiKeyRef) await deleteSecret(engine.apiKeyRef);
  delete config.engines[id];
  if (config.activeEngineId === id) {
    config.activeEngineId = Object.keys(config.engines)[0] ?? '';
  }
  await saveConfig(config);
}

/** 设当前激活引擎。 */
export async function setActiveEngine(id: string): Promise<void> {
  await patchConfig({ activeEngineId: id });
}

// ─── 辅助 ──────────────────────────────────────────────────────────────────
function generateId(): string {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 当前激活引擎（无则 null）。 */
export function activeEngine(config: AppConfig): EngineConfig | null {
  return config.engines[config.activeEngineId] ?? null;
}

/** 用于 popup/控制条透明化展示的引擎标签。 */
export function engineLabel(engine: EngineConfig | null): string {
  return engine ? `${engine.label}` : '未配置引擎';
}
