/** 引擎管理：增删改引擎 + API Key 加密管理（架构 6.2 / 7.2，任务交付物「引擎管理」）。 */
import { useEffect, useState } from 'preact/hooks';
import type { AppConfig, EngineProvider } from '../../shared/types';
import { ENGINE_PROVIDERS } from '../../shared/constants';
import {
  PROVIDER_PRESETS,
  addEngine,
  removeEngine,
  setEngineApiKey,
  updateEngine,
  validateEngine,
} from '../../background/config/config-store';
import { hasSecret } from '../../background/config/secret-store';

interface EngineManagerProps {
  config: AppConfig;
  onChanged: () => void;
}

interface NewEngineForm {
  label: string;
  provider: EngineProvider;
  baseUrl: string;
  model: string;
  contextWindow: number;
  maxOutput: number;
}

function emptyForm(): NewEngineForm {
  return {
    label: '',
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    contextWindow: 128_000,
    maxOutput: 4096,
  };
}

export function EngineManager({ config, onChanged }: EngineManagerProps) {
  const [form, setForm] = useState<NewEngineForm>(emptyForm);
  const [errors, setErrors] = useState<string[]>([]);
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({});

  // 各引擎 Key 是否已配置（异步查 secret-store）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        Object.values(config.engines).map(async (e) => [e.id, e.apiKeyRef ? await hasSecret(e.apiKeyRef) : false] as const),
      );
      if (!cancelled) setKeyStatus(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [config.engines]);

  async function onAdd() {
    const errs = validateEngine(form);
    if (errs.length) {
      setErrors(errs);
      return;
    }
    setErrors([]);
    await addEngine(form);
    setForm(emptyForm());
    onChanged();
  }

  async function onProviderChange(provider: EngineProvider) {
    const preset = PROVIDER_PRESETS[provider];
    setForm((f) => ({ ...f, provider, baseUrl: preset.baseUrl, model: preset.model }));
  }

  return (
    <div class="card">
      <h2>引擎管理</h2>
      <p class="muted">填自己的 Key 接任意 LLM（OpenAI / Anthropic / Gemini / Ollama / OpenAI 兼容）。Key 经 AES-GCM 加密本地存储，绝不进云同步。</p>

      {Object.values(config.engines).map((e) => (
        <EngineRow key={e.id} engine={e} active={config.activeEngineId === e.id} hasKey={!!keyStatus[e.id]} onChanged={onChanged} />
      ))}

      <div class="engine">
        <div class="engine-head">
          <b>＋ 新增引擎</b>
        </div>
        <div class="row">
          <label>名称</label>
          <input type="text" placeholder="如：DeepSeek" value={form.label} onInput={(e) => setForm((f) => ({ ...f, label: e.currentTarget.value }))} />
        </div>
        <div class="row">
          <label>Provider</label>
          <select value={form.provider} onChange={(e) => onProviderChange(e.currentTarget.value as EngineProvider)}>
            {ENGINE_PROVIDERS.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div class="row">
          <label>Base URL</label>
          <input type="url" placeholder="https://api.example.com/v1" value={form.baseUrl} onInput={(e) => setForm((f) => ({ ...f, baseUrl: e.currentTarget.value }))} />
        </div>
        <div class="row">
          <label>Model</label>
          <input type="text" placeholder="如：gpt-4o-mini" value={form.model} onInput={(e) => setForm((f) => ({ ...f, model: e.currentTarget.value }))} />
        </div>
        <div class="grid2">
          <div class="row">
            <label>Context</label>
            <input type="number" value={form.contextWindow} onInput={(e) => setForm((f) => ({ ...f, contextWindow: Number(e.currentTarget.value) || 0 }))} />
          </div>
          <div class="row">
            <label>MaxOutput</label>
            <input type="number" value={form.maxOutput} onInput={(e) => setForm((f) => ({ ...f, maxOutput: Number(e.currentTarget.value) || 0 }))} />
          </div>
        </div>
        {errors.length > 0 && <div class="muted" style={{ color: 'var(--bt-danger)' }}>{errors.join('；')}</div>}
        <div class="row">
          <button class="primary" onClick={onAdd}>添加引擎</button>
        </div>
      </div>
    </div>
  );
}

interface EngineRowProps {
  engine: import('../../shared/types').EngineConfig;
  active: boolean;
  hasKey: boolean;
  onChanged: () => void;
}

function EngineRow({ engine, active, hasKey, onChanged }: EngineRowProps) {
  const [apiKey, setApiKey] = useState('');
  const [saved, setSaved] = useState(false);

  async function patch(field: keyof typeof engine, value: string | number | boolean) {
    await updateEngine(engine.id, { [field]: value });
    onChanged();
  }

  async function saveKey() {
    if (!apiKey.trim()) return;
    await setEngineApiKey(engine.id, apiKey.trim());
    setApiKey('');
    setSaved(true);
    onChanged();
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div class="engine">
      <div class="engine-head">
        <b>{engine.label || engine.id}</b>
        <span>
          {active && <span class="badge">当前引擎</span>}{' '}
          <span class={hasKey ? 'badge' : 'badge muted'}>{hasKey ? 'Key 已设置' : 'Key 未设置'}</span>
        </span>
      </div>
      <div class="row">
        <label>名称</label>
        <input type="text" value={engine.label} onInput={(e) => patch('label', e.currentTarget.value)} />
      </div>
      <div class="row">
        <label>Base URL</label>
        <input type="url" value={engine.baseUrl} onInput={(e) => patch('baseUrl', e.currentTarget.value)} />
      </div>
      <div class="grid2">
        <div class="row">
          <label>Model</label>
          <input type="text" value={engine.model} onInput={(e) => patch('model', e.currentTarget.value)} />
        </div>
        <div class="row">
          <label>Context</label>
          <input type="number" value={engine.contextWindow} onInput={(e) => patch('contextWindow', Number(e.currentTarget.value) || 0)} />
        </div>
      </div>
      <div class="row">
        <label>API Key</label>
        <input type="password" placeholder={hasKey ? '••••••（已加密存储，输入新值即重置）' : '输入 API Key'} value={apiKey} onInput={(e) => setApiKey(e.currentTarget.value)} />
        <button class="primary" onClick={saveKey} disabled={!apiKey.trim()}>{hasKey ? '重置 Key' : '保存 Key'}</button>
        {saved && <span class="badge">已保存</span>}
      </div>
      <div class="row">
        <button class="danger" onClick={async () => { await removeEngine(engine.id); onChanged(); }}>删除引擎</button>
      </div>
    </div>
  );
}
