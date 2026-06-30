/**
 * 智能体模式配置 UI（P1-3 交付物 #4）。
 *
 * P1-1 已落定 AgentConfig schema（systemPrompt / role / stylePreset / pageContextEnabled）；
 * 本组件出 UI。术语库编辑器依赖 P1-1 的 glossary store（IndexedDB glossaries store），
 * 该 store 尚未落定，故术语库编辑暂以只读提示占位 —— 待 P1-1 glossary store 合入后接入。
 */
import type { AppConfig, StylePreset } from '../../shared/types';
import { patchConfig } from '../../background/config/config-store';

const STYLE_PRESETS: ReadonlyArray<readonly [StylePreset, string]> = [
  ['none', '无'],
  ['literary', '文学'],
  ['technical', '技术'],
  ['casual', '口语'],
];

const DEFAULT_SYSTEM_PROMPT =
  'You are a professional translator. Translate faithfully, preserve terminology consistency, and keep inline markup placeholders verbatim.';

export function AgentSection({ config }: { config: AppConfig }) {
  const a = config.agent;
  const set = (patch: Partial<typeof a>) => void patchConfig({ agent: patch });

  return (
    <div class="card">
      <h2>智能体模式</h2>
      <p class="muted">切换到「智能体」模式后生效；自定义系统提示词 / 角色 / 风格预设（架构 4.3 / 6.2 agent）。</p>
      <div class="row">
        <label>角色</label>
        <input
          type="text"
          value={a.role}
          placeholder="如：You are a senior technical translator."
          onChange={(e) => set({ role: e.currentTarget.value })}
        />
      </div>
      <div class="row">
        <label>风格预设</label>
        <select value={a.stylePreset} onChange={(e) => set({ stylePreset: e.currentTarget.value as StylePreset })}>
          {STYLE_PRESETS.map(([v, name]) => (
            <option key={v} value={v}>{name}</option>
          ))}
        </select>
      </div>
      <div class="row" style="align-items:flex-start;">
        <label>系统提示词</label>
        <textarea
          value={a.systemPrompt}
          placeholder={DEFAULT_SYSTEM_PROMPT}
          onChange={(e) => set({ systemPrompt: e.currentTarget.value })}
          rows={4}
          style="width:100%;min-width:200px;font-size:13px;padding:6px 9px;border:1px solid var(--bt-border);border-radius:6px;font-family:inherit;"
        />
      </div>
      <div class="row">
        <label>术语库</label>
        <span class="muted">术语库编辑器待 P1-1 glossary store 落定后接入（当前 agent.glossaryIds 留空即可）。</span>
      </div>
    </div>
  );
}
