/**
 * Batch-translation data types.
 *
 * These are the structural shapes the batcher/protocol modules operate on. They
 * are intentionally narrow and self-contained so the pure-function core is fully
 * unit-testable without the WXT/browser runtime. Field names mirror the shared
 * types planned for `src/shared/types.ts` (P0-2 / TRA-3): when that lands these
 * can be re-exported from there, or the orchestrator (Stage 3) reconciles them —
 * the shapes are structurally compatible (same `id` + `text` contract from
 * ARCHITECTURE.md §4.2).
 */

/** A single translatable segment. `id` is stable (paragraphId) and `text` is
 *  the source string with inline markup already replaced by `[[n]]` placeholders. */
export interface BatchItem {
  id: string;
  text: string;
}

/** An alias for the input item — kept distinct from the response item so intent
 *  reads clearly at call sites, even though the wire shape is identical. */
export type Item = BatchItem;

/** One batch = the set of items sent in a single LLM request. */
export interface Batch {
  id: string;
  items: BatchItem[];
}

/** One translated item returned by the LLM. `id` aligns back to the input id. */
export interface TranslationItem {
  id: string;
  text: string;
}

/** Per-batch token budget. `inputMax` is already derated from the engine context
 *  window (ARCHITECTURE.md §4.5: input ≤ 70% window, output reserved). */
export interface TokenBudget {
  /** Maximum input tokens allowed in a single batch (prompt overhead included). */
  inputMax: number;
  /** Optional per-batch item-count cap; defaults to MAX_ITEMS_PER_BATCH (20). */
  maxItems?: number;
}

// ── Prompt context (protocol layer) ─────────────────────────────────────────

/** A single source→target term the model must follow (agent/expert mode).
 *  规范定义在 src/types/agent.ts（智能体契约单一来源），此处 import 供本模块使用并
 *  re-export 保持既有导入路径稳定。 */
import type { GlossaryPair } from '../../types/agent';
export type { GlossaryPair };

/** Agent/expert mode prompt additions (P1 surface; wired now as the extension
 *  point on buildSystemPrompt). All fields optional. */
export interface AgentPromptContext {
  /** Free-form role line, e.g. "You are a senior ML translator...". */
  role?: string;
  stylePreset?: 'literary' | 'technical' | 'casual' | 'none' | (string & {});
  /** Term pairs injected as a "must follow" glossary. */
  glossary?: GlossaryPair[];
  /** Page title / prior-segment summary for context-aware translation. */
  pageContext?: string;
}

/** Input to buildSystemPrompt / promptFingerprint. */
export interface PromptContext {
  targetLang: string;
  sourceLang?: string;
  mode?: 'basic' | 'agent';
  /** When mode === 'agent', the role/style/glossary/context additions. */
  agent?: AgentPromptContext;
  /**
   * 页面上下文（标题/前段摘要），基础模式注入 `Context:` 段（架构 §8 P1）。
   * 智能体模式改走 `agent.pageContext`，此处不重复注入。由 orchestrator 在打包前调
   * context-builder 产出，token 预算已从 batch inputMax 扣除。
   */
  pageContext?: string;
}
