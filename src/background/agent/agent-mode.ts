/**
 * 智能体模式编排 + 质量回退（架构 §4.6 / P1-1）。
 *
 * runAgentBatch：在单批上跑「智能体尝试 → 质量回退」决策链。
 *   1. 用 prompt-builder 产出 agent system prompt + user JSON，调引擎。
 *   2. parseResponse + alignByIds（复用 P0-4 批量协议，纯函数）。
 *   3. 质量回退（架构 P1-1）：解析失败 / 空结果 / 对齐失败（有缺段）→ 自动降级
 *      基础模式，对**未成功段**重发基础 system prompt，记录 FallbackReason。
 *   4. ★ 不重翻已成功段：agent 尝试已对齐的段直接保留，基础模式只重发缺段。
 *   5. 基础模式仍缺 → 计入 failedIds（不再递归，交由上层 orchestrator 决定是否 ERROR）。
 *
 * 「纯函数决策」：回退判定 / 对齐 / 合并均为纯逻辑；唯一副作用是引擎调用，以
 * AgentEngine 接口注入（测试传 mock 引擎，运行时由 runtime-deps 注入带 retry 包装的引擎）。
 * 不含 DOM / 浏览器 API。
 */
import {
  alignByIds,
  buildSystemPrompt,
  buildUserMessage,
  parseResponse,
  type ParseOutcome,
} from '../batcher/protocol';
import type { BatchItem } from '../batcher/types';
import type {
  AgentBatchResult,
  AgentPromptInput,
  FallbackReason,
} from '../../types/agent';
import { buildAgentSystemPrompt } from './prompt-builder';

/**
 * 引擎抽象（最小契约）。运行时由 runtime-deps 用 retry 包装真实引擎注入；
 * 测试直接传 mock。仅暴露 translate，故 runAgentBatch 不感知 provider 差异。
 */
export interface AgentEngine {
  translate(req: {
    systemPrompt: string;
    userMessage: string;
    targetLang: string;
    jsonMode: boolean;
    signal?: AbortSignal;
  }): Promise<{ content: string }>;
}

/** runAgentBatch 入参。 */
export interface RunAgentBatchInput {
  /** 本批待译段（已按 token 预算切好，由 packer 产出）。 */
  items: BatchItem[];
  /** 已解析的智能体提示词输入（glossaryIds 已 → pairs）。 */
  agent: AgentPromptInput;
  /** 目标语言（agent.targetLang 与此应一致；以此为准注入 basic 回退 prompt）。 */
  targetLang: string;
  /** 引擎（带 retry 包装，由调用方注入）。 */
  engine: AgentEngine;
  /** 中止信号；aborted 时抛 AbortError，不进入回退。 */
  signal?: AbortSignal;
}

/** 单次引擎调用：组 user JSON → translate → 返回 content。AbortError 直抛。 */
async function callEngine(
  engine: AgentEngine,
  systemPrompt: string,
  items: BatchItem[],
  targetLang: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await engine.translate({
    systemPrompt,
    userMessage: buildUserMessage(items),
    targetLang,
    jsonMode: true,
    signal,
  });
  return res.content;
}

/** 对齐辅助：把 ParseOutcome/ items 与给定 items 列表对齐，返回 translated + missing。 */
function alignTo(
  parsed: ParseOutcome,
  items: BatchItem[],
): { translated: Map<string, string>; missing: string[] } {
  const result = alignByIds(parsed, { id: 'agent-mode', items });
  return { translated: result.translated, missing: result.missing };
}

/**
 * 执行智能体批量翻译 + 质量回退。
 *
 * 回退触发条件（架构 P1-1「达阈值」）：
 *   - parse_error：agent 响应无法解析 → 全部段进入基础模式重发。
 *   - empty_result：解析成功但 0 段对齐 → 全部段进入基础模式重发。
 *   - alignment_failure：部分对齐有缺段 → 仅缺段进入基础模式重发（已对齐段保留）。
 *
 * @throws AbortError signal 已中止或引擎中止时直抛（不进入回退）。
 */
export async function runAgentBatch(input: RunAgentBatchInput): Promise<AgentBatchResult> {
  const { items, agent, targetLang, engine, signal } = input;
  if (items.length === 0) {
    return {
      translated: new Map(),
      failedIds: [],
      fellBackToBasic: false,
      attempts: [],
    };
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const translated = new Map<string, string>();
  const attempts: AgentBatchResult['attempts'] = [];

  // ── 1. 智能体尝试 ───────────────────────────────────────────────────────
  const agentSystem = buildAgentSystemPrompt(agent);
  const agentRaw = await callEngine(engine, agentSystem, items, targetLang, signal);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const agentParsed = parseResponse(agentRaw);
  let pending: BatchItem[];
  let fallbackReason: FallbackReason | undefined;

  if (!agentParsed.ok) {
    fallbackReason = 'parse_error';
    pending = items;
    attempts.push({
      mode: 'agent',
      ok: false,
      translatedCount: 0,
      missingCount: items.length,
      reason: 'parse_error',
    });
  } else {
    const { translated: aligned, missing } = alignTo(agentParsed, items);
    for (const [id, text] of aligned) translated.set(id, text);

    if (translated.size === 0) {
      // 解析成功但零对齐（如返回的 id 全部不在输入中）→ 空结果回退。
      fallbackReason = 'empty_result';
      pending = items;
      attempts.push({
        mode: 'agent',
        ok: false,
        translatedCount: 0,
        missingCount: items.length,
        reason: 'empty_result',
      });
    } else if (missing.length > 0) {
      // 部分对齐：保留已对齐段，仅缺段进基础模式重发（★ 不重翻已成功段）。
      fallbackReason = 'alignment_failure';
      const missingSet = new Set(missing);
      pending = items.filter((it) => missingSet.has(it.id));
      attempts.push({
        mode: 'agent',
        ok: false,
        translatedCount: translated.size,
        missingCount: missing.length,
        reason: 'alignment_failure',
      });
    } else {
      // 全量对齐成功，无需回退。
      attempts.push({
        mode: 'agent',
        ok: true,
        translatedCount: translated.size,
        missingCount: 0,
      });
      return {
        translated,
        failedIds: [],
        fallbackReason: undefined,
        fellBackToBasic: false,
        attempts,
      };
    }
  }

  // ── 2. 基础模式回退（仅对 pending 未成功段）─────────────────────────────
  const basicSystem = buildSystemPrompt({
    targetLang,
    sourceLang: agent.sourceLang,
    mode: 'basic',
  });
  const basicRaw = await callEngine(engine, basicSystem, pending, targetLang, signal);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const basicParsed = parseResponse(basicRaw);
  let failedIds: string[];
  if (!basicParsed.ok) {
    failedIds = pending.map((it) => it.id);
    attempts.push({
      mode: 'basic',
      ok: false,
      translatedCount: 0,
      missingCount: pending.length,
      reason: 'parse_error',
    });
  } else {
    const { translated: basicAligned } = alignTo(basicParsed, pending);
    for (const [id, text] of basicAligned) translated.set(id, text);
    failedIds = pending.filter((it) => !translated.has(it.id)).map((it) => it.id);
    attempts.push({
      mode: 'basic',
      ok: basicAligned.size > 0,
      translatedCount: basicAligned.size,
      missingCount: failedIds.length,
      ...(basicAligned.size === 0 && failedIds.length > 0 ? { reason: 'empty_result' } : {}),
    });
  }

  return {
    translated,
    failedIds,
    fallbackReason,
    fellBackToBasic: true,
    attempts,
  };
}
