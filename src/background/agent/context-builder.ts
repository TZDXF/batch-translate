/**
 * 页面上下文感知构建（架构 §4.3 / §8 P1 项「页面上下文感知」）。
 *
 * 把「页面标题 + 前 N 段原文摘要」拼装成一段 context 文本，注入到 system prompt
 * 的 `Context:` 段（基础模式见 protocol.buildSystemPrompt，智能体模式见
 * prompt-builder.buildAgentSystemPrompt），让跨段指代 / 术语在长文档中保持一致。
 *
 * ── 设计要点 ──────────────────────────────────────────────────────────────
 *   - 纯函数：无 DOM / fetch / 浏览器 API，可单测（架构 §3「纯函数优先」）。
 *   - 原文 hash 去重：同一原文（菜单/页脚重复段落）只取一次，避免浪费预算。
 *     hash 复用 protocol.fingerprintString（djb2，与缓存指纹同算法，单一来源）。
 *   - token 预算截断：标题优先纳入（高价值、短），随后逐段累加直到预算用尽，
 *     保证上下文不挤占批段预算（架构 §4.5「上下文 token 预算计入 batch 预估」）。
 *   - 不破坏批量协议：context 仅是 system prompt 的自然语言段落，不含 `[[n]]`
 *     占位符、不触碰 JSON id 对齐契约（架构 §4.3 约束）。
 *
 * ── 注入策略（本 issue 决策，见 issue 约束讨论） ──────────────────────────
 *   - 每批注入：context 进 system prompt，system prompt 全批共用 → 每批都带上下文，
 *     保证跨批一致性（首批-only 会让后续批失去上下文）。
 *   - 预算占比：context 预算 = 批输入预算的 PAGE_CONTEXT_BUDGET_RATIO（默认 10%），
 *     上限 PAGE_CONTEXT_BUDGET_CAP（默认 512 tokens），由调用方从 batch inputMax 扣除。
 *     10% 在连贯性与批量合并之间平衡：太少无效果，太多压缩批段、抬升并发数。
 */
import { fingerprintString } from '../batcher/protocol';
import { estimateTokens, type TokenProvider } from '../batcher/token-estimator';

/** 上下文 token 预算占批输入预算的比例（架构 §4.5 预算分配）。 */
export const PAGE_CONTEXT_BUDGET_RATIO = 0.1;

/** 上下文 token 预算硬上限，避免大窗口引擎把上下文撑到数千 token。 */
export const PAGE_CONTEXT_BUDGET_CAP = 512;

/** buildPageContext 入参。 */
export interface PageContextInput {
  /** 页面标题（document.title），可选 —— 用户可关「发送 title」（架构 §7.3）。 */
  title?: string;
  /** 按出现顺序的前 N 段原文，用于摘要。重复段按原文 hash 去重。 */
  priorSegments: string[];
  /** 上下文 token 预算上限（已由调用方按 ratio+cap 折算后传入）。 */
  tokenBudget: number;
  /** token 估算函数，默认 estimateTokens；可注入便于测试用确定性 token 模型。 */
  estimate?: (text: string) => number;
  /** 引擎 provider，透传给 estimateTokens 选 BPE / 字符比例（架构 §4.5）。 */
  provider?: TokenProvider;
}

/** buildPageContext 产物。 */
export interface PageContextResult {
  /** 拼装好的上下文段；空串表示无可用上下文（调用方应跳过注入）。 */
  text: string;
  /** 实际消耗的 token 数（≤ tokenBudget）。 */
  tokens: number;
  /** 去重后实际纳入摘要的段数。 */
  segmentCount: number;
}

/**
 * 由批输入预算折算上下文 token 预算（ratio × inputMax，再 cap）。
 * 供 orchestrator 在打包前扣除上下文开销；至少留 0（无上下文）。
 */
export function contextTokenBudget(inputMax: number): number {
  if (!Number.isFinite(inputMax) || inputMax <= 0) return 0;
  return Math.min(PAGE_CONTEXT_BUDGET_CAP, Math.floor(inputMax * PAGE_CONTEXT_BUDGET_RATIO));
}

/**
 * 构建页面上下文段。
 *
 * 拼装格式（架构 §4.3 `Context: {pageContext}`）：
 * ```
 * Title: <title>
 * Prior context:
 * - <seg1>
 * - <seg2>
 * ```
 * 标题缺失则省略 `Title:` 行；无任何前段且无标题 → 返回空串（不注入）。
 *
 * 去重：按 fingerprintString(原文) 累积 seen 集合，重复段跳过（菜单/页脚等重复内容）。
 * 截断：标题先扣预算；随后逐段累加，单段超剩余预算则截断到预算内（保留前缀）后停止。
 * 空白段（trim 后为空）跳过。
 */
export function buildPageContext(input: PageContextInput): PageContextResult {
  const estimate = input.estimate ?? ((t: string) => estimateTokens(t, input.provider));
  const budget = Math.max(0, Math.floor(input.tokenBudget));

  const lines: string[] = [];
  let tokens = 0;

  const title = input.title?.trim();
  if (title) {
    const titleLine = `Title: ${title}`;
    const titleTokens = estimate(titleLine);
    // 标题优先纳入；若标题本身已超预算，截断标题而非丢弃（标题高价值）。
    if (titleTokens > budget && budget > 0) {
      const kept = truncateToBudget(titleLine, budget, estimate);
      lines.push(kept.text);
      tokens = kept.tokens;
    } else if (titleTokens <= budget) {
      lines.push(titleLine);
      tokens += titleTokens;
    }
    // budget === 0 且标题非空 → 标题也丢弃（无预算可用）。
  }

  let segmentCount = 0;
  const seen = new Set<string>();
  let stopped = false;
  for (const raw of input.priorSegments) {
    if (stopped) break;
    const seg = typeof raw === 'string' ? raw.trim() : '';
    if (!seg) continue;
    const hash = fingerprintString(seg);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const line = `- ${seg}`;
    const lineTokens = estimate(line);
    if (tokens + lineTokens <= budget) {
      lines.push(line);
      tokens += lineTokens;
      segmentCount += 1;
    } else if (budget - tokens > 0) {
      // 剩余预算放不下整段 → 截断到剩余预算内（保留段首，维持上下文线索）。
      const remaining = budget - tokens;
      const kept = truncateToBudget(line, remaining, estimate);
      if (kept.text) {
        lines.push(kept.text);
        tokens += kept.tokens;
        segmentCount += 1;
      }
      stopped = true;
    } else {
      stopped = true;
    }
  }

  if (lines.length === 0) {
    return { text: '', tokens: 0, segmentCount: 0 };
  }

  // 仅前段、无标题时，不加 `Prior context:` 头会显得突兀；统一加头让 LLM 明确语义。
  // 但若只有 Title 行（lines 长度1 且以 Title: 开头），不加头。
  let text: string;
  const hasSegments = segmentCount > 0;
  if (hasSegments) {
    // 在 Title 行与段之间插入头。
    const titleIdx = lines.findIndex((l) => l.startsWith('Title:'));
    if (titleIdx >= 0) {
      text = [...lines.slice(0, titleIdx + 1), 'Prior context:', ...lines.slice(titleIdx + 1)].join('\n');
    } else {
      text = ['Prior context:', ...lines].join('\n');
    }
  } else {
    text = lines.join('\n');
  }

  return { text, tokens, segmentCount };
}

/**
 * 截断单行到 token 预算内，按字符逐步削尾。
 * 返回截断后文本及其 token 数（保证 tokens ≤ budget）。
 */
function truncateToBudget(line: string, budget: number, estimate: (t: string) => number): { text: string; tokens: number } {
  if (budget <= 0) return { text: '', tokens: 0 };
  let current = line;
  let currentTokens = estimate(current);
  // 逐步削尾直到满足预算；保留至少 1 字符预算空间避免死循环。
  while (currentTokens > budget && current.length > 1) {
    current = current.slice(0, -1);
    currentTokens = estimate(current);
  }
  if (currentTokens > budget) return { text: '', tokens: 0 };
  return { text: current, tokens: currentTokens };
}
