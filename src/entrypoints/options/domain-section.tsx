/** 域名策略配置（P1-3）：黑名单 / 白名单模式 + 域名列表编辑。 */
import type { AppConfig, DomainPolicy } from '../../shared/types';
import { patchConfig } from '../../background/config/config-store';
import { normalizeDomainEntry } from '../../content/domain-policy';

export function DomainSection({ config }: { config: AppConfig }) {
  const d = config.domain;
  const list = d.mode === 'whitelist' ? d.whitelist : d.blacklist;

  const setMode = (mode: DomainPolicy['mode']) => void patchConfig({ domain: { mode } });
  const setList = (text: string) => {
    const items = text
      .split(/[\s,;\n]+/)
      .map(normalizeDomainEntry)
      .filter(Boolean);
    void patchConfig({ domain: { [d.mode]: items } as Partial<DomainPolicy> });
  };

  return (
    <div class="card">
      <h2>按域名开关 / 白名单</h2>
      <p class="muted">content script 启动时按当前域名决定是否允许翻译（架构 P1-3）。</p>
      <div class="row">
        <label>模式</label>
        <select value={d.mode} onChange={(e) => setMode(e.currentTarget.value as DomainPolicy['mode'])}>
          <option value="blacklist">黑名单（名单内不译，其余译）</option>
          <option value="whitelist">白名单（仅名单内译，其余不译）</option>
        </select>
      </div>
      <div class="row">
        <label>{d.mode === 'whitelist' ? '白名单域名' : '黑名单域名'}</label>
        <textarea
          value={list.join('\n')}
          onChange={(e) => setList(e.currentTarget.value)}
          rows={4}
          placeholder={'example.com\nsub.example.com'}
          style="width:100%;min-width:200px;font-size:13px;padding:6px 9px;border:1px solid var(--bt-border);border-radius:6px;font-family:inherit;"
        />
      </div>
      <div class="hint">每行一个域名；支持子域后缀匹配（example.com 同时命中 sub.example.com）。粘贴整条 URL 亦可。</div>
    </div>
  );
}
