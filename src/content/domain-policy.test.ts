/** 域名匹配逻辑测试（P1-3 纯函数，验收：黑名单域名页面不自动翻译）。 */
import { describe, expect, it } from 'vitest';
import {
  isDomainAllowed,
  matchDomain,
  normalizeDomainEntry,
  normalizeHostname,
} from './domain-policy';
import type { DomainPolicy } from '../shared/types';

const blacklist: DomainPolicy = { mode: 'blacklist', blacklist: ['example.com', 'evil.org'], whitelist: [] };
const whitelist: DomainPolicy = { mode: 'whitelist', blacklist: [], whitelist: ['example.com'] };

describe('normalizeHostname', () => {
  it('小写 + 剥离 www. + 去尾点', () => {
    expect(normalizeHostname('WWW.Example.com')).toBe('example.com');
    expect(normalizeHostname('example.com.')).toBe('example.com');
    expect(normalizeHostname('  Sub.Example.COM ')).toBe('sub.example.com');
    expect(normalizeHostname('')).toBe('');
  });
});

describe('normalizeDomainEntry', () => {
  it('从粘贴的 URL 提取主机名', () => {
    expect(normalizeDomainEntry('https://example.com/path')).toBe('example.com');
    expect(normalizeDomainEntry('http://sub.example.com:8080/x')).toBe('sub.example.com');
    expect(normalizeDomainEntry('user:pass@evil.org/')).toBe('evil.org');
    expect(normalizeDomainEntry('EXAMPLE.COM')).toBe('example.com');
  });
});

describe('matchDomain（后缀匹配 + 点边界）', () => {
  it('子域命中父域', () => {
    expect(matchDomain('sub.example.com', 'example.com')).toBe(true);
    expect(matchDomain('a.b.example.com', 'example.com')).toBe(true);
  });
  it('点边界防拼前缀命中', () => {
    expect(matchDomain('levil.com', 'evil.com')).toBe(false);
    expect(matchDomain('notexample.com', 'example.com')).toBe(false);
  });
  it('精确命中', () => {
    expect(matchDomain('example.com', 'example.com')).toBe(true);
    expect(matchDomain('example.com', 'other.com')).toBe(false);
  });
});

describe('isDomainAllowed（策略判定）', () => {
  it('黑名单：命中不译，其余允许', () => {
    expect(isDomainAllowed('example.com', blacklist)).toBe(false);
    expect(isDomainAllowed('sub.example.com', blacklist)).toBe(false);
    expect(isDomainAllowed('evil.org', blacklist)).toBe(false);
    expect(isDomainAllowed('safe.com', blacklist)).toBe(true);
  });
  it('白名单：仅命中允许，其余不译', () => {
    expect(isDomainAllowed('example.com', whitelist)).toBe(true);
    expect(isDomainAllowed('sub.example.com', whitelist)).toBe(true);
    expect(isDomainAllowed('other.com', whitelist)).toBe(false);
  });
  it('空 host（about: 页）一律不允许', () => {
    expect(isDomainAllowed('', blacklist)).toBe(false);
    expect(isDomainAllowed('', whitelist)).toBe(false);
  });
  it('默认黑名单空 → 全部允许', () => {
    const empty: DomainPolicy = { mode: 'blacklist', blacklist: [], whitelist: [] };
    expect(isDomainAllowed('anywhere.com', empty)).toBe(true);
  });
  it('白名单空 → 全部不允许', () => {
    const emptyW: DomainPolicy = { mode: 'whitelist', blacklist: [], whitelist: [] };
    expect(isDomainAllowed('anywhere.com', emptyW)).toBe(false);
  });
});
