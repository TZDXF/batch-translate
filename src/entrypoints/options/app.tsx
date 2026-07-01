/** Options 页主体：翻译设置 / 调度参数 / 缓存管理 / 隐私说明（任务交付物 #1）。 */
import { useEffect, useState } from 'preact/hooks';
import type { AppConfig, TranslateMode } from '../../shared/types';
import {
  SCHEDULING_LIMITS,
  loadConfig,
  patchConfig,
  subscribeToConfig,
} from '../../background/config/config-store';
import { clearCache, getCacheStats, type CacheStats } from '../../background/config/cache-actions';
import { EngineManager } from './engine-manager';
import { DomainSection } from './domain-section';
import { ShortcutsSection } from './shortcuts-section';
import { AgentSection } from './agent-section';

const LANGUAGES: ReadonlyArray<readonly [string, string]> = [
  ['zh-CN', '简体中文'],
  ['zh-TW', '繁體中文'],
  ['en', 'English'],
  ['ja', '日本語'],
  ['ko', '한국어'],
  ['fr', 'Français'],
  ['de', 'Deutsch'],
  ['es', 'Español'],
  ['ru', 'Русский'],
];

function useConfig(): AppConfig | null {
  const [cfg, setCfg] = useState<AppConfig | null>(null);
  useEffect(() => {
    void loadConfig().then(setCfg);
    return subscribeToConfig(setCfg);
  }, []);
  return cfg;
}

export function App() {
  const config = useConfig();
  if (!config) return <div class="wrap">加载配置中…</div>;

  return (
    <div class="wrap">
      <h1>BatchTranslate 设置</h1>
      <p class="subtitle">自带 Key 接任意 LLM · 批量合并降并发 · 本地缓存 · 纯本地隐私</p>

      <EngineManager config={config} onChanged={() => {}} />

      <TranslationSection config={config} />
      <AgentSection config={config} />
      <SchedulingSection config={config} />
      <DomainSection config={config} />
      <ShortcutsSection config={config} />
      <CacheSection />
      <PrivacySection config={config} />
    </div>
  );
}

function TranslationSection({ config }: { config: AppConfig }) {
  return (
    <div class="card">
      <h2>翻译设置</h2>
      <div class="row">
        <label>目标语言</label>
        <select value={config.targetLang} onChange={(e) => void patchConfig({ targetLang: e.currentTarget.value })}>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
      </div>
      <div class="row">
        <label>源语言</label>
        <select value={config.sourceLang} onChange={(e) => void patchConfig({ sourceLang: e.currentTarget.value })}>
          <option value="auto">自动检测</option>
          {LANGUAGES.map(([code, name]) => (
            <option key={code} value={code}>{name}</option>
          ))}
        </select>
      </div>
      <div class="row">
        <label>模式</label>
        <select
          value={config.mode}
          onChange={(e) => void patchConfig({ mode: e.currentTarget.value as TranslateMode })}
        >
          <option value="basic">基础（批量 JSON 协议）</option>
          <option value="agent">智能体（角色 / 术语 / 风格）</option>
        </select>
        <span class="muted">智能体模式可自定义系统提示词 / 角色 / 风格预设（见下方）</span>
      </div>
      <div class="row">
        <label>流式渲染</label>
        <input
          type="checkbox"
          checked={config.streaming.enabled}
          onChange={(e) => void patchConfig({ streaming: { enabled: e.currentTarget.checked } })}
        />
        <span class="muted">开启后译文边出边显（长页面体感更快）；关闭则整批返回，与 P0 一致</span>
      </div>
      <div class="row">
        <label>悬停翻译模式</label>
        <input
          type="checkbox"
          checked={config.ui.hoverOnly}
          onChange={(e) => void patchConfig({ ui: { hoverOnly: e.currentTarget.checked } })}
        />
        <span class="muted">开启后仅悬停段落即时翻译（轻量按需、低 token），不再自动批量翻译整页；可与按域名白名单组合</span>
      </div>
    </div>
  );
}

function SchedulingSection({ config }: { config: AppConfig }) {
  const s = config.scheduling;
  const set = (patch: Partial<typeof s>) => void patchConfig({ scheduling: patch });

  return (
    <div class="card">
      <h2>调度参数</h2>
      <p class="muted">全局唯一 Service Worker 限流，避免并发过高触发 429（架构 5.3）。</p>
      <div class="grid2">
        <NumField label="全局并发" value={s.maxConcurrent} min={SCHEDULING_LIMITS.maxConcurrent.min} max={SCHEDULING_LIMITS.maxConcurrent.max} hint="1–10，默认 3" onChange={(v) => set({ maxConcurrent: v })} />
        <NumField label="RPS（请求/秒）" value={s.rps} min={SCHEDULING_LIMITS.rps.min} max={SCHEDULING_LIMITS.rps.max} step={0.1} hint="防 429，默认 2" onChange={(v) => set({ rps: v })} />
        <NumField label="单批段数" value={s.itemsPerBatch} min={SCHEDULING_LIMITS.itemsPerBatch.min} max={SCHEDULING_LIMITS.itemsPerBatch.max} hint={`1–${SCHEDULING_LIMITS.itemsPerBatch.max}，默认 20`} onChange={(v) => set({ itemsPerBatch: v })} />
        <NumField label="最大重试" value={s.maxRetries} min={SCHEDULING_LIMITS.maxRetries.min} max={SCHEDULING_LIMITS.maxRetries.max} hint="默认 5" onChange={(v) => set({ maxRetries: v })} />
        <NumField label="TPM 限额" value={s.tpmLimit} min={SCHEDULING_LIMITS.tpmLimit.min} max={SCHEDULING_LIMITS.tpmLimit.max} hint="0=关闭额度保护" onChange={(v) => set({ tpmLimit: v })} />
        <NumField label="输入占窗比" value={s.batchTokenBudgetRatio} min={SCHEDULING_LIMITS.batchTokenBudgetRatio.min} max={SCHEDULING_LIMITS.batchTokenBudgetRatio.max} step={0.05} hint="默认 0.7" onChange={(v) => set({ batchTokenBudgetRatio: v })} />
      </div>
    </div>
  );
}

function NumField(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  hint: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div class="row">
        <label>{props.label}</label>
        <input
          type="number"
          value={props.value}
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          onChange={(e) => props.onChange(Number(e.currentTarget.value) || 0)}
        />
      </div>
      <div class="hint">{props.hint}</div>
    </div>
  );
}

function CacheSection() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [cleared, setCleared] = useState(false);

  useEffect(() => {
    void loadConfig().then(setConfig);
    return subscribeToConfig(setConfig);
  }, []);

  useEffect(() => {
    void getCacheStats().then(setStats);
  }, [cleared]);

  if (!config) return null;
  const c = config.cache;

  return (
    <div class="card">
      <h2>缓存管理</h2>
      <div class="row">
        <label>启用本地缓存</label>
        <input
          type="checkbox"
          checked={c.enabled}
          onChange={(e) => void patchConfig({ cache: { enabled: e.currentTarget.checked } })}
        />
      </div>
      <div class="grid2">
        <NumField label="容量上限 (MB)" value={c.maxSizeMB} min={1} max={10000} hint="LRU 淘汰，默认 100" onChange={(v) => void patchConfig({ cache: { maxSizeMB: v } })} />
        <NumField label="TTL (天)" value={c.ttlDays} min={0} max={3650} hint="0=永久" onChange={(v) => void patchConfig({ cache: { ttlDays: v } })} />
      </div>
      <div class="row">
        <label>统计</label>
        <span class="muted">
          条目 {stats?.entryCount ?? 0} · 请求数 {stats?.requestCount ?? 0} · 缓存命中 {stats?.cacheHits ?? 0}
        </span>
      </div>
      <div class="row">
        <button class="danger" onClick={async () => { await clearCache(); setCleared((x) => !x); }}>一键清空缓存</button>
      </div>
    </div>
  );
}

function PrivacySection({ config }: { config: AppConfig }) {
  return (
    <div class="card privacy">
      <h2>隐私说明</h2>
      <ul class="muted">
        <li><b>纯本地，无后端</b>：原文/译文仅在本地 Service Worker 与你填写的 LLM endpoint 之间流动，不经过任何本项目服务器。</li>
        <li><b>零遥测</b>：不集成 GA / PostHog / Sentry，无崩溃上报。</li>
        <li><b>Key 加密存储</b>：API Key 经 AES-GCM 加密后存本地，绝不进 storage.sync（云同步）。</li>
        <li><b>无分享链接</b>：结果只存本地 IndexedDB，绝不生成可被搜索引擎抓取的公开链接。</li>
      </ul>
      <div class="row">
        <label>发送页面上下文</label>
        <input
          type="checkbox"
          checked={config.agent.pageContextEnabled}
          onChange={(e) => void patchConfig({ agent: { pageContextEnabled: e.currentTarget.checked } })}
        />
        <span class="muted">关闭时仅发送段落文本，不发送页面 URL / 标题（默认关闭）</span>
      </div>
    </div>
  );
}
