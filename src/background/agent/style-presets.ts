/**
 * 风格预设（架构 §4.3 / §6.2 agent.stylePreset，P1-1）。
 *
 * 风格预设把 StylePreset 枚举（literary/technical/casual/none）展开为可注入 prompt
 * 的描述性指令文本。`none` 表示不附加风格约束（返回空串）。
 *
 * 内置预设对齐架构示例与中文用户语境：
 *   - literary  → 信达雅（文学化、注重达意与文采）
 *   - technical → 学术/技术（术语精准、表述严谨）
 *   - casual    → 口语化（自然通俗、贴近日常表达）
 *   - none      → 不约束
 *
 * 纯函数，无副作用，可单测。
 */
import type { StylePreset } from '../../shared/types';

/** 预设 → 风格指令文本。 */
export const STYLE_PRESETS: Readonly<Record<Exclude<StylePreset, 'none'>, string>> = {
  literary:
    '信达雅：译文追求忠实原文（信）、通顺流畅（达）、文采得体（雅），避免生硬直译，保持原文的语气与修辞。',
  technical:
    '学术/技术：术语翻译精准且前后一致，表述严谨客观，保留专业含义，不增译不意译，公式/代码/单位保持原样。',
  casual:
    '口语化：译文自然通俗，贴近日常口语表达，避免书面腔与翻译腔，句子简短易懂。',
};

/**
 * 解析预设为 prompt 指令文本。`none` / 未知值 → 空串（不附加风格行）。
 * 调用方据此决定是否输出 `Style:` 行。
 */
export function resolveStyleInstruction(preset: StylePreset | undefined): string {
  if (!preset || preset === 'none') return '';
  return STYLE_PRESETS[preset] ?? '';
}

/** 列出全部内置预设 id（供 options UI 渲染下拉项）。 */
export function listStylePresets(): StylePreset[] {
  return ['none', 'literary', 'technical', 'casual'];
}
