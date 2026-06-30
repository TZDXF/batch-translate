/**
 * 智能体模式类型契约（架构 §4.3 / §6.2 / P1-1）。
 *
 * 本文件是智能体提示词层 + 质量回退的「messages 契约」单一来源：
 *   - AgentConfig / StylePreset 复用 shared/types（配置持久化形状，架构 6.2）。
 *   - GlossaryPair 在此处定义为规范源，batcher/types 反向 re-export，避免双定义漂移。
 *   - Glossary：术语库集合（架构 6.1 glossaries store 的 value 形状）。
 *   - AgentPromptInput：已解析（glossaryIds → pairs）的纯提示词输入，prompt-builder 消费。
 *   - FallbackReason / AgentBatchResult：agent-mode 质量回退决策产物。
 *
 * 纯类型，无运行时依赖，可跨 SW / options / 测试共享。
 */
import type { AgentConfig, StylePreset } from '../shared/types';
export type { AgentConfig, StylePreset };

/** 单条源→目标术语对（架构 4.3 glossary 约束段）。规范定义于此。 */
export interface GlossaryPair {
  src: string;
  tgt: string;
}

/** 术语库集合（架构 6.1 IndexedDB glossaries store 的 value）。 */
export interface Glossary {
  id: string;
  name: string;
  pairs: GlossaryPair[];
  enabled: boolean;
}

/**
 * 已解析的智能体提示词输入。glossaryIds 已在此层之前解析为 pairs，故 prompt-builder
 * 保持纯函数（不依赖 IDB / store 查询）。所有字段可选 —— 缺省即回退基础模板。
 */
export interface AgentPromptInput {
  targetLang: string;
  sourceLang?: string;
  /** 用户自定义系统提示词，覆盖默认 translator intro（架构 6.2 agent.systemPrompt）。 */
  systemPrompt?: string;
  /** 角色行，如 "You are a senior ML translator..."。 */
  role?: string;
  stylePreset?: StylePreset;
  /** 已解析的术语对，注入 prompt 约束段。 */
  glossary?: GlossaryPair[];
  /** 页面标题 / 前段摘要，上下文感知（架构 4.3 pageContext）。 */
  pageContext?: string;
}

/** 质量回退触发原因（架构 P1-1：智能体失败自动降级基础模式）。 */
export type FallbackReason = 'parse_error' | 'empty_result' | 'alignment_failure';

/** 单次尝试（agent / basic）的决策日志，供观测回退链路。 */
export interface AgentAttempt {
  mode: 'agent' | 'basic';
  /** 本次尝试是否产出可用译文（parse 成功且至少 1 段对齐）。 */
  ok: boolean;
  translatedCount: number;
  missingCount: number;
  reason?: FallbackReason;
}

/** runAgentBatch 的产物：已对齐译文 + 仍失败段 + 回退元信息。 */
export interface AgentBatchResult {
  /** id → 译文（agent 成功段 + basic 回退成功段的并集）。 */
  translated: Map<string, string>;
  /** 经 agent + basic 回退仍未得到的段 id。 */
  failedIds: string[];
  /** 触发基础模式回退的原因；未回退则 undefined。 */
  fallbackReason?: FallbackReason;
  /** 是否发生过基础模式回退。 */
  fellBackToBasic: boolean;
  /** 决策日志（agent 尝试 + 可选 basic 回退尝试）。 */
  attempts: AgentAttempt[];
}
