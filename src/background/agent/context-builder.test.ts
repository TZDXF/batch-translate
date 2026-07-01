/**
 * context-builder 单测（架构 §4.3 / §8 P1「页面上下文感知」）。
 *
 * 覆盖：上下文拼装格式、原文 hash 去重、token 预算截断、占位符 `[[n]]` verbatim
 * 约束不被破坏、与 P1-1 agent 模式组合不破坏回退（通过 prompt-builder 间接验证）。
 *
 * 用确定性 token 模型（1 token/字符）隔离估算误差，使预算边界可精确断言。
 */
import { describe, it, expect, vi } from 'vitest';

// 确定性 token 模型：1 token/字符。隔离真实估算器，使预算边界精确。
const estimate = vi.fn((text: string) => Array.from(text).length);

import {
  buildPageContext,
  contextTokenBudget,
  PAGE_CONTEXT_BUDGET_RATIO,
  PAGE_CONTEXT_BUDGET_CAP,
} from './context-builder';
import { buildAgentSystemPrompt, agentPromptFingerprint } from './prompt-builder';
import type { AgentPromptInput } from '../../types/agent';
import { BASE_TRANSLATOR_RULES } from '../batcher/protocol';

const baseInput = (over: Partial<Parameters<typeof buildPageContext>[0]> = {}) =>
  ({
    priorSegments: [],
    tokenBudget: 512,
    estimate,
    ...over,
  }) as Parameters<typeof buildPageContext>[0];

describe('context-builder — buildPageContext', () => {
  it('返回空串当无标题且无前段', () => {
    const r = buildPageContext(baseInput());
    expect(r.text).toBe('');
    expect(r.tokens).toBe(0);
    expect(r.segmentCount).toBe(0);
  });

  it('仅标题：产出 Title 行，无 Prior context 头', () => {
    const r = buildPageContext(baseInput({ title: 'Transformers 论文笔记' }));
    expect(r.text).toBe('Title: Transformers 论文笔记');
    expect(r.segmentCount).toBe(0);
    expect(r.tokens).toBe(Array.from('Title: Transformers 论文笔记').length);
  });

  it('标题 + 前段：Title 在前，Prior context 头接段列表', () => {
    const r = buildPageContext(
      baseInput({ title: 'T', priorSegments: ['第一段。', '第二段。'] }),
    );
    expect(r.text).toBe('Title: T\nPrior context:\n- 第一段。\n- 第二段。');
    expect(r.segmentCount).toBe(2);
  });

  it('仅前段（无标题）：Prior context 头 + 段列表', () => {
    const r = buildPageContext(baseInput({ priorSegments: ['A.', 'B.'] }));
    expect(r.text).toBe('Prior context:\n- A.\n- B.');
    expect(r.segmentCount).toBe(2);
  });

  it('原文 hash 去重：重复段只出现一次', () => {
    const r = buildPageContext(
      baseInput({ priorSegments: ['重复段。', '别的段。', '重复段。'] }),
    );
    expect(r.segmentCount).toBe(2);
    expect(r.text.match(/重复段。/g)).toHaveLength(1);
    expect(r.text).toContain('别的段。');
  });

  it('空白段跳过（trim 后为空）', () => {
    const r = buildPageContext(baseInput({ priorSegments: ['', '   ', '有效段。'] }));
    expect(r.segmentCount).toBe(1);
    expect(r.text).toContain('有效段。');
  });

  it('token 预算截断：超预算的段被截断后停止累加', () => {
    // 预算 20 tokens；标题 'Title: T' = 9 tokens；剩余 11。
    // 第一段 '- aaaaaaaaaa' (12) 超剩余 11 → 截断到 11 字符，停止。
    const r = buildPageContext(
      baseInput({ title: 'T', priorSegments: ['aaaaaaaaaa', 'bbbb'], tokenBudget: 20 }),
    );
    expect(r.tokens).toBeLessThanOrEqual(20);
    expect(r.segmentCount).toBe(1); // 截断算纳入但停止后续
    expect(r.text).toContain('Title: T');
    // 第二段 'bbbb' 不应出现（已停止）
    expect(r.text).not.toContain('bbbb');
  });

  it('token 预算截断：无标题，整段超预算时截断到预算内', () => {
    // 预算 5；段 '- abcdefghij' (12) 超 5 → 截断到 5 字符
    const r = buildPageContext(
      baseInput({ priorSegments: ['abcdefghij'], tokenBudget: 5 }),
    );
    expect(r.tokens).toBeLessThanOrEqual(5);
    expect(r.segmentCount).toBe(1);
  });

  it('预算为 0：返回空串（无可用预算）', () => {
    const r = buildPageContext(
      baseInput({ title: 'T', priorSegments: ['段。'], tokenBudget: 0 }),
    );
    expect(r.text).toBe('');
    expect(r.tokens).toBe(0);
  });

  it('标题本身超预算：截断标题而非丢弃', () => {
    // 预算 10；标题 'Title: 很长很长的标题文字内容' 远超 10
    const r = buildPageContext(
      baseInput({ title: '很长很长的标题文字内容xyz', tokenBudget: 10 }),
    );
    expect(r.tokens).toBeLessThanOrEqual(10);
    expect(r.text.startsWith('Title: ')).toBe(true);
  });

  it('tokens 永远 ≤ tokenBudget', () => {
    const r = buildPageContext(
      baseInput({
        title: 'T',
        priorSegments: ['一二三四五六七八九十', '甲乙丙丁', '子丑寅卯辰巳午未申酉戌亥'],
        tokenBudget: 30,
      }),
    );
    expect(r.tokens).toBeLessThanOrEqual(30);
  });
});

describe('context-builder — contextTokenBudget', () => {
  it('按 ratio 折算，受 cap 限制', () => {
    // 4000 * 0.1 = 400 < cap(512)
    expect(contextTokenBudget(4000)).toBe(400);
    // 10000 * 0.1 = 1000 > cap → 512
    expect(contextTokenBudget(10000)).toBe(PAGE_CONTEXT_BUDGET_CAP);
  });

  it('非正数输入返回 0', () => {
    expect(contextTokenBudget(0)).toBe(0);
    expect(contextTokenBudget(-1)).toBe(0);
    expect(contextTokenBudget(Number.NaN)).toBe(0);
  });

  it('ratio 与 cap 常量符合架构决策', () => {
    expect(PAGE_CONTEXT_BUDGET_RATIO).toBe(0.1);
    expect(PAGE_CONTEXT_BUDGET_CAP).toBe(512);
  });
});

describe('context-builder — 不破坏批量协议契约', () => {
  it('上下文含原文占位符时，prompt 仍 verbatim 强约束 [[n]] 不译不序不删', () => {
    // 上下文段是原文摘要，原文里的 [[0]] 会原样出现在 context 里 —— 这只是语义提示，
    // 不参与 id 对齐。关键不变量：六条规则仍 verbatim 在 prompt 末尾，强约束 LLM
    // 在 user message 的 items 里保持占位符 verbatim。
    const ctx = buildPageContext(
      baseInput({ title: 'T', priorSegments: ['含 [[0]] 占位符的段', '普通段'] }),
    );
    const prompt = buildAgentSystemPrompt({
      targetLang: '简体中文',
      pageContext: ctx.text,
    } as AgentPromptInput);
    // 规则 4 verbatim 在场（占位符约束单一来源，禁漂移）
    expect(prompt).toContain(
      'Preserve inline markup placeholders like [[0]], [[1]] verbatim — do not translate, reorder, or delete them.',
    );
    // context 里的 [[0]] 是原文摘要，与规则并存；规则仍强调 verbatim。
    expect(ctx.text).toContain('[[0]]');
  });

  it('注入 agent system prompt 后六条规则仍 verbatim 在场', () => {
    const ctx = buildPageContext(
      baseInput({ title: 'Transformers', priorSegments: ['Attention is all you need.'] }),
    );
    const prompt = buildAgentSystemPrompt({
      targetLang: '简体中文',
      pageContext: ctx.text,
    } as AgentPromptInput);
    for (const rule of BASE_TRANSLATOR_RULES) {
      expect(prompt).toContain(rule);
    }
    expect(prompt).toContain('[[0]], [[1]] verbatim');
    expect(prompt).toContain('Context: ');
    expect(prompt).toContain('Title: Transformers');
  });

  it('pageContext 变化 → agent 指纹变化（缓存不串味）', () => {
    const noCtx = agentPromptFingerprint({ targetLang: '简体中文' } as AgentPromptInput);
    const withCtx = agentPromptFingerprint({
      targetLang: '简体中文',
      pageContext: 'Title: X',
    } as AgentPromptInput);
    expect(noCtx).not.toBe(withCtx);
  });

  it('空上下文不注入 Context 段（agent 回退路径不受影响）', () => {
    const empty = buildPageContext(baseInput());
    const prompt = buildAgentSystemPrompt({
      targetLang: '简体中文',
      pageContext: empty.text,
    } as AgentPromptInput);
    // 空串 trim 后 prompt-builder 跳过 Context 行
    expect(prompt).not.toMatch(/^Context:/m);
    // 规则与一致性收尾仍在
    expect(prompt).toContain('Maintain terminology consistency across all items.');
  });
});
