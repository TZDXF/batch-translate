/**
 * 按域名开关 / 翻译白名单 —— 纯函数（P1-3，架构 P1 路线图）。
 *
 * content script 启动时按当前 hostname + DomainPolicy 决定是否允许翻译：
 *  - blacklist（默认）：hostname 命中黑名单 → 不译；其余允许。
 *  - whitelist：hostname 命中白名单 → 允许；其余不译。
 *
 * 匹配规则：列表项为「后缀匹配」域名（如 "example.com" 同时命中 "sub.example.com"）。
 * 逐项精确匹配亦可（"sub.example.com" 只命中自身）。www. 前缀自动归一化剥离后再比较，
 * 避免 www.example.com 与 example.com 误判为不同站。
 *
 * 纯函数无 DOM / chrome 依赖，便于 vitest 覆盖（验收：黑名单域名页面不自动翻译）。
 */
import type { DomainPolicy } from '../shared/types';

/** 归一化主机名：小写 + 去尾点 + 剥离前导 www.。空串保留为空。 */
export function normalizeHostname(host: string): string {
  let h = (host ?? '').trim().toLowerCase();
  if (!h) return '';
  if (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

/** 归一化配置项中的域名条目（剥离协议/路径/端口，便于用户粘贴 URL 也能匹配）。 */
export function normalizeDomainEntry(entry: string): string {
  let v = (entry ?? '').trim().toLowerCase();
  if (!v) return '';
  // 用户可能粘贴整条 URL：剥离 scheme 与 path/port。
  const schemeIdx = v.indexOf('://');
  if (schemeIdx >= 0) v = v.slice(schemeIdx + 3);
  const slashIdx = v.indexOf('/');
  if (slashIdx >= 0) v = v.slice(0, slashIdx);
  const atIdx = v.lastIndexOf('@');
  if (atIdx >= 0) v = v.slice(atIdx + 1);
  const colonIdx = v.indexOf(':');
  if (colonIdx >= 0) v = v.slice(0, colonIdx);
  return normalizeHostname(v);
}

/** host 是否匹配某域名条目（后缀匹配，按点边界，防 "evil.com" 命中 "levil.com"）。 */
export function matchDomain(host: string, entry: string): boolean {
  const h = normalizeHostname(host);
  const e = normalizeDomainEntry(entry);
  if (!h || !e) return false;
  if (h === e) return true;
  // 后缀匹配：h 必须以 "."+e 结尾，确保子域命中而拼前缀不命中。
  return h.endsWith(`.${e}`);
}

/** host 是否在给定列表中命中任一条目。 */
export function matchAnyDomain(host: string, list: readonly string[]): boolean {
  return list.some((entry) => matchDomain(host, entry));
}

/**
 * 按域名策略判定当前 host 是否允许翻译。
 * - blacklist：命中黑名单 → false；其余 true。
 * - whitelist：命中白名单 → true；其余 false。
 * host 为空（如 about: 页）→ 一律不允许（无域名可判）。
 */
export function isDomainAllowed(host: string, policy: DomainPolicy): boolean {
  const h = normalizeHostname(host);
  if (!h) return false;
  if (policy.mode === 'whitelist') {
    return matchAnyDomain(h, policy.whitelist);
  }
  // blacklist
  return !matchAnyDomain(h, policy.blacklist);
}
