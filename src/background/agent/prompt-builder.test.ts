import { describe, it, expect } from 'vitest';
import {
  buildAgentSystemPrompt,
  buildAgentMessages,
  agentPromptFingerprint,
} from './prompt-builder';
import type { AgentPromptInput } from '../../types/agent';
import { BASE_TRANSLATOR_RULES, baseTranslatorIntro } from '../batcher/protocol';

const base = (over: Partial<AgentPromptInput> = {}): AgentPromptInput => ({
  targetLang: '简体中文',
  ...over,
});

describe('prompt-builder', () => {
  describe('buildAgentSystemPrompt', () => {
    it('uses the default translator intro when no custom systemPrompt', () => {
      const prompt = buildAgentSystemPrompt(base());
      expect(prompt).toContain(baseTranslatorIntro('简体中文'));
    });

    it('overrides the intro with the user systemPrompt when provided', () => {
      const prompt = buildAgentSystemPrompt(base({ systemPrompt: '你是法律文书译者。' }));
      expect(prompt).toContain('你是法律文书译者。');
      expect(prompt).not.toContain(baseTranslatorIntro('简体中文'));
    });

    it('emits the role line when role is set', () => {
      const prompt = buildAgentSystemPrompt(base({ role: 'You are a senior ML translator.' }));
      expect(prompt).toContain('You are a senior ML translator.');
    });

    it('emits Style line from a known preset and omits it for "none"', () => {
      const withStyle = buildAgentSystemPrompt(base({ stylePreset: 'literary' }));
      expect(withStyle).toMatch(/^Style: .*信达雅/m);

      const none = buildAgentSystemPrompt(base({ stylePreset: 'none' }));
      expect(none).not.toMatch(/^Style:/m);
    });

    it('injects the glossary constraint section from resolved pairs', () => {
      const prompt = buildAgentSystemPrompt(
        base({ glossary: [{ src: 'GPU', tgt: '图形处理器' }] }),
      );
      expect(prompt).toContain('Glossary (must follow, source→target):');
      expect(prompt).toContain('- GPU → 图形处理器');
    });

    it('injects page context when provided', () => {
      const prompt = buildAgentSystemPrompt(base({ pageContext: 'Title: Transformers' }));
      expect(prompt).toContain('Context: Title: Transformers');
    });

    it('preserves the batch-protocol rules verbatim ([[n]] + JSON id alignment)', () => {
      const prompt = buildAgentSystemPrompt(
        base({ role: 'r', stylePreset: 'technical', glossary: [{ src: 'a', tgt: 'b' }] }),
      );
      // 六条不变契约逐条在场（与 protocol.BASE_TRANSLATOR_RULES 同源，禁漂移）
      for (const rule of BASE_TRANSLATOR_RULES) {
        expect(prompt).toContain(rule);
      }
      expect(prompt).toContain('[[0]], [[1]] verbatim');
      expect(prompt).toContain('{"items":[{"id":string,"text":string}]}');
      expect(prompt).toContain('One input id → one output id');
      expect(prompt).toContain('Maintain terminology consistency across all items.');
    });

    it('places agent修饰段 before Rules so the contract stays emphatic at the end', () => {
      const prompt = buildAgentSystemPrompt(
        base({ role: 'ROLE_LINE', glossary: [{ src: 'GPU', tgt: '图形处理器' }] }),
      );
      const roleIdx = prompt.indexOf('ROLE_LINE');
      const glossaryIdx = prompt.indexOf('Glossary');
      const rulesIdx = prompt.indexOf('Rules:');
      expect(roleIdx).toBeLessThan(glossaryIdx);
      expect(glossaryIdx).toBeLessThan(rulesIdx);
    });
  });

  describe('buildAgentMessages', () => {
    it('produces system + user JSON envelope; user round-trips items', () => {
      const items = [
        { id: '1', text: 'Hello.' },
        { id: '2', text: 'World.' },
      ];
      const msgs = buildAgentMessages(base({ role: 'r' }), items);
      expect(msgs.system).toContain('r');
      expect(JSON.parse(msgs.user)).toEqual({
        items: [
          { id: '1', text: 'Hello.' },
          { id: '2', text: 'World.' },
        ],
      });
    });
  });

  describe('agentPromptFingerprint', () => {
    it('is stable for identical input', () => {
      const a = agentPromptFingerprint(base({ role: 'r', stylePreset: 'literary' }));
      const b = agentPromptFingerprint(base({ role: 'r', stylePreset: 'literary' }));
      expect(a).toBe(b);
      expect(a).toMatch(/^[0-9a-f]+$/);
    });

    it('changes when role/style/glossary/pageContext/systemPrompt/targetLang changes', () => {
      const base_fp = agentPromptFingerprint(base());
      expect(agentPromptFingerprint(base({ role: 'r' }))).not.toBe(base_fp);
      expect(agentPromptFingerprint(base({ stylePreset: 'literary' }))).not.toBe(base_fp);
      expect(agentPromptFingerprint(base({ glossary: [{ src: 'a', tgt: 'b' }] }))).not.toBe(base_fp);
      expect(agentPromptFingerprint(base({ pageContext: 'ctx' }))).not.toBe(base_fp);
      expect(agentPromptFingerprint(base({ systemPrompt: 'custom' }))).not.toBe(base_fp);
      expect(agentPromptFingerprint(base({ targetLang: 'English' }))).not.toBe(base_fp);
    });
  });
});
