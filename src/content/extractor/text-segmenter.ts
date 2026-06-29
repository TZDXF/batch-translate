/**
 * 文本切分 — src/content/extractor/text-segmenter.ts
 *
 * 见 docs/ARCHITECTURE.md 第 4.5 节（分批算法中「单段超预算 → 再切按句」）。
 *
 * 导出 `splitBySentence(text, maxTokens)`：把长文本按句切分为若干块，每块 token 估算
 * 不超过 maxTokens，供 packer 对超限单段再切。纯函数，无 DOM / 无浏览器 API。
 *
 * 关键约束：**绝不在 `[[n]]` 占位符内部切分**，否则会破坏与 P0-4 批量协议呼应的
 * 占位符 verbatim 契约。
 *
 * 注：token 估算用保守字符比例（中文 1.5 tok/char，英文 0.25 tok/char，逐字符按类型
 * 累加并向上取整），与 token-estimator（P0-4）的非 OpenAI fallback 口径一致；此处内联
 * 是为了让本模块对 background 层零依赖、可独立单测。
 */

/** CJK 与全角标点统一区段（用于判定「中文」字符，按 1.5 tok/char 计）。 */
const CJK_RE = /[㐀-鿿豈-﫿\u{20000}-\u{2ffff}　-〿＀-￯]/u;

/**
 * 保守 token 估算：中文/全角字符按 1.5，其余按 0.25，向上取整。
 * 「保守取大」即宁可高估，触发更早切分，避免超 context window。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk * 1.5 + other * 0.25);
}

/** 主句末边界：。！？与半角 ! ? 以及换行。匹配时保留在所属句末。 */
const SENTENCE_END_RE = /[。！？!?]+|\n+/;

/** 占位符 token，切分时作为不可分割原子。 */
const TOKEN_RE = /\[\[\d+\]\]/;

/**
 * 按句切分文本为单元（保留句末标点 / 换行），占位符作为原子不被拆开。
 * 返回的每个单元都是一个完整句子或一行（可能含占位符）。
 */
function splitToSentences(text: string): string[] {
  const sentences: string[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    // 优先消费一个完整占位符原子。
    const tok = rest.match(TOKEN_RE);
    if (tok && tok.index !== undefined && tok.index === 0) {
      buf += tok[0];
      i += tok[0].length;
      continue;
    }
    const ch = text[i];
    const end = rest.match(SENTENCE_END_RE);
    if (end && end.index !== undefined && end.index === 0) {
      buf += end[0];
      sentences.push(buf);
      buf = '';
      i += end[0].length;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.length) sentences.push(buf);
  return sentences;
}

/** 次级边界：；;，,、 分号 / 逗号，用于对单个超限句再切。 */
const CLAUSE_RE = /[；;，,、]+/;

/**
 * 对单个仍超 maxTokens 的句子做次级切分（先按子句，再按字符硬切），
 * 始终避免在占位符内部断开。保证返回非空且整体有进展。
 */
function hardSplit(text: string, maxTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text];

  // 1) 按子句边界切，保留边界。
  const clauses: string[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const tok = rest.match(TOKEN_RE);
    if (tok && tok.index !== undefined && tok.index === 0) {
      buf += tok[0];
      i += tok[0].length;
      continue;
    }
    const clauseEnd = rest.match(CLAUSE_RE);
    if (clauseEnd && clauseEnd.index !== undefined && clauseEnd.index === 0) {
      clauses.push(buf);
      buf = clauseEnd[0];
      i += clauseEnd[0].length;
      // 边界本身单独成段太碎，并入下一段开头。
      continue;
    }
    buf += text[i];
    i += 1;
  }
  if (buf.length) clauses.push(buf);

  // 2) 子句仍超限 → 按字符硬切（在占位符原子边界切，绝不切开 [[n]]）。
  const units = clauses.flatMap((c) => (estimateTokens(c) <= maxTokens ? [c] : charChunk(c, maxTokens)));
  return units.filter((u) => u.length > 0);
}

/** 按字符硬切，遇占位符原子整块带走。 */
function charChunk(text: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const tok = rest.match(TOKEN_RE);
    const atom = tok && tok.index !== undefined && tok.index === 0 ? tok[0]! : text[i]!;
    // 若加入 atom 会让 buf 超限且 buf 非空 → 先 flush。
    if (buf && estimateTokens(buf + atom) > maxTokens) {
      chunks.push(buf);
      buf = '';
    }
    buf += atom;
    i += atom.length;
  }
  if (buf.length) chunks.push(buf);
  return chunks;
}

/**
 * 把长文本按句切分为块，每块 token 估算 ≤ maxTokens。
 *
 * - 整体不超限时直接返回 `[text]`；
 * - 否则先按句切，单句仍超则按子句 / 字符再切；
 * - 最后贪心打包相邻单元到 ≤ maxTokens 的块。
 *
 * maxTokens < 1 时按 1 处理，避免无限切分。
 */
export function splitBySentence(text: string, maxTokens: number): string[] {
  const budget = Math.max(1, Math.floor(maxTokens));
  if (text.length === 0) return [];
  if (estimateTokens(text) <= budget) return [text];

  // 单元：句子（超限的已进一步切碎）。
  const units = splitToSentences(text).flatMap((s) =>
    estimateTokens(s) <= budget ? [s] : hardSplit(s, budget),
  );

  // 贪心打包。
  const chunks: string[] = [];
  let cur = '';
  for (const u of units) {
    if (!u) continue;
    if (!cur) {
      cur = u;
    } else if (estimateTokens(cur + u) <= budget) {
      cur += u;
    } else {
      chunks.push(cur);
      cur = u;
    }
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}
