/**
 * 同步确定性缓存键（FNV-1a 64bit）—— orchestrator 与 content 侧共用的单一事实来源。
 *
 * 背景：cache-key.ts 的 `cacheKey` 用 Web Crypto sha256（异步）。orchestrator 的
 * Cache.cacheKey 契约是同步的（构建 key 后立刻 await getMany），故 runtime-deps 用
 * 本函数做同步 key。输入仍是 (source+engineId+fingerprint+targetLang)，与 sha256 同
 * 输入、同区分度，仅非加密强度；缓存 key 只需确定性 + 低碰撞，FNV-1a 64bit 足够。
 *
 * ★ content 侧「编辑译文回写缓存 / 手动重译逐出缓存」必须产出与 orchestrator 完全一致
 * 的 key，否则二次访问不会命中被覆盖的值。故把该函数从 runtime-deps 提取到此处共享，
 * 避免逻辑重复导致 key 漂移。
 *
 * 跨 SW 卸载 / 重启：同输入产出同 key，幂等命中行为与 sha256 等价。
 */

const SEP = ' ';

/**
 * 生成同步缓存键。
 * 字段顺序固定: source | engineId | fingerprint | targetLang，NUL 分隔防碰撞。
 */
export function syncCacheKey(
  source: string,
  engineId: string,
  fingerprint: string,
  targetLang: string,
): string {
  const data = [source, engineId, fingerprint, targetLang].join(SEP);
  // FNV-1a 64bit（用两段 32bit 拼接，Math.imul 保证 32bit 回绕）。
  let h1 = 0xcbf29ce4 >>> 0;
  let h2 = 0x84222325 >>> 0;
  for (let i = 0; i < data.length; i++) {
    const c = data.codePointAt(i)!;
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return `${engineId}|${fingerprint}|${targetLang}|${h1.toString(16)}${h2.toString(16)}`;
}
