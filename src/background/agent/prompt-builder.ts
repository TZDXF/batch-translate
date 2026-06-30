/**
 * 智能体提示词构建（架构 §4.3，P1-1）。
 *
 * 在基础批量翻译协议之上拼装「智能体模式」system/user messages：
 *   - 用户自定义 systemPrompt（覆盖默认 translator intro）
 *   - 角色 role
 *   - 风格预设 stylePreset（经 style-presets 展开为指令文本）
 *   - 术语库 glossary（经 glossary.formatGlossarySection 注入约束段）
 *   - 页面上下文 pageContext
 *
 * ★ 批量协议契约不破坏：JSON id 对齐、`[[n]]` verbatim 等六条规则直接复用
 *   protocol.BASE_TRANSLATOR_RULES（单一来源，禁止漂移）。agent 修饰段置于规则之前，
 *   规则始终在末尾强调，确保结构化输出契约稳固。
 *
 * 纯函数，无 DOM / fetch / 浏览器 API，可单测。
 */
import {
  BASE_TRANSLATOR_RULES,
  baseTranslatorIntro,
  buildUserMessage,
  fingerprintString,
} from '../batcher/protocol';
import type { BatchItem } from '../batcher/types';
import type { AgentPromptInput } from '../../types/agent';
import { resolveStyleInstruction } from './style-presets';
import { formatGlossarySection } from './glossary';

/** 拼装好的 messages 契约（架构 4.3 system + 4.2 user JSON）。 */
export interface AgentMessages {
  system: string;
  user: string;
}

/**
 * 构建智能体模式 system prompt。
 *
 * 结构（自上而下）：
 *   1. intro：用户 systemPrompt 覆盖 / 否则默认 translator intro（含 targetLang）。
 *   2. role：角色行（可选）。
 *   3. Style：风格指令文本（stylePreset !== 'none' 时）。
 *   4. Glossary：术语约束段（有 pairs 时）。
 *   5. Context：页面上下文（可选）。
 *   6. Rules：批量协议六条不变契约（verbatim 复用 protocol）。
 *   7. Maintain terminology consistency across all items.
 */
export function buildAgentSystemPrompt(input: AgentPromptInput): string {
  const lines: string[] = [];

  const custom = input.systemPrompt?.trim();
  lines.push(custom && custom.length > 0 ? custom : baseTranslatorIntro(input.targetLang));

  const role = input.role?.trim();
  if (role) lines.push(role);

  const style = resolveStyleInstruction(input.stylePreset);
  if (style) lines.push(`Style: ${style}`);

  const glossary = formatGlossarySection(input.glossary);
  if (glossary) lines.push(glossary);

  const ctx = input.pageContext?.trim();
  if (ctx) lines.push(`Context: ${ctx}`);

  lines.push('Rules:');
  lines.push(...BASE_TRANSLATOR_RULES);
  lines.push('Maintain terminology consistency across all items.');
  return lines.join('\n');
}

/**
 * 构建智能体模式 messages：system 用 buildAgentSystemPrompt，user 用批量协议
 * §4.2 JSON 信封（直接复用 protocol.buildUserMessage，id+text 契约不变）。
 */
export function buildAgentMessages(input: AgentPromptInput, items: BatchItem[]): AgentMessages {
  return {
    system: buildAgentSystemPrompt(input),
    user: buildUserMessage(items),
  };
}

/**
 * 智能体提示词指纹（架构 6.1 cacheKey 组成之一）。换 systemPrompt/role/style/
 * glossary/pageContext/targetLang → 指纹变 → 不命中旧缓存。基于构建好的 system
 * prompt 做 djb2（与 protocol.promptFingerprint 同算法），保证 basic / agent 两路
 * 指纹空间一致、可比较。
 */
export function agentPromptFingerprint(input: AgentPromptInput): string {
  return fingerprintString(buildAgentSystemPrompt(input));
}
