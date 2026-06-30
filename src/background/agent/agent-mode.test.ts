import { describe, it, expect } from 'vitest';
import { runAgentBatch, type AgentEngine } from './agent-mode';
import type { AgentPromptInput } from '../../types/agent';

// 引擎请求形状（与 AgentEngine.translate 入参一致）。
interface EngineReq {
  systemPrompt: string;
  userMessage: string;
  targetLang: string;
  jsonMode: boolean;
  signal?: AbortSignal;
}

/** 构造批量协议 JSON 响应原文。 */
function json(pairs: Array<[id: string, text: string]>): string {
  return JSON.stringify({ items: pairs.map(([id, text]) => ({ id, text })) });
}

/** 解析 userMessage 信封回 items。 */
function parseUser(req: EngineReq): Array<{ id: string; text: string }> {
  return (JSON.parse(req.userMessage) as { items: Array<{ id: string; text: string }> }).items;
}

/** mock 引擎：记录全部调用，按 responder 返回内容。responder 可据 systemPrompt 区分 agent/basic。 */
function makeEngine(responder: (req: EngineReq) => string | Promise<string>): {
  engine: AgentEngine;
  calls: EngineReq[];
} {
  const calls: EngineReq[] = [];
  const engine: AgentEngine = {
    async translate(req) {
      calls.push(req);
      const content = await responder(req);
      return { content };
    },
  };
  return { engine, calls };
}

const AGENT_ROLE = 'AGENT_ROLE_MARKER';
const agentInput = (over: Partial<AgentPromptInput> = {}): AgentPromptInput => ({
  targetLang: '简体中文',
  role: AGENT_ROLE,
  ...over,
});

const items = [
  { id: '1', text: 'one' },
  { id: '2', text: 'two' },
  { id: '3', text: 'three' },
  { id: '4', text: 'four' },
];

/** 判定一次调用是否走的是 agent 提示词（含角色标记），否则为基础回退提示词。 */
const isAgentCall = (req: EngineReq): boolean => req.systemPrompt.includes(AGENT_ROLE);

describe('runAgentBatch', () => {
  it('full agent success: no fallback, single engine call, all translated', async () => {
    const { engine, calls } = makeEngine(() =>
      json([
        ['1', '一'],
        ['2', '二'],
        ['3', '三'],
        ['4', '四'],
      ]),
    );
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fellBackToBasic).toBe(false);
    expect(result.fallbackReason).toBeUndefined();
    expect(result.failedIds).toEqual([]);
    expect(result.translated.get('1')).toBe('一');
    expect(result.translated.get('4')).toBe('四');
    expect(calls.length).toBe(1);
    expect(result.attempts.length).toBe(1);
    expect(result.attempts[0]).toMatchObject({ mode: 'agent', ok: true });
  });

  it('parse_error: falls back to basic, resends ALL items, basic prompt has no agent block', async () => {
    const { engine, calls } = makeEngine((req) =>
      isAgentCall(req) ? 'not json at all' : json([['1', '一'], ['2', '二'], ['3', '三'], ['4', '四']]),
    );
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fellBackToBasic).toBe(true);
    expect(result.fallbackReason).toBe('parse_error');
    expect(result.failedIds).toEqual([]);
    expect(result.translated.size).toBe(4);
    expect(calls.length).toBe(2);
    // 回退用的是基础提示词（无角色标记，仍有 Rules 契约）
    expect(isAgentCall(calls[1]!)).toBe(false);
    expect(calls[1]!.systemPrompt).toContain('Rules:');
    // 全量重发
    expect(parseUser(calls[1]!).length).toBe(4);
  });

  it('empty_result: agent parses but 0 aligned → fallback resends all', async () => {
    const { engine, calls } = makeEngine((req) =>
      isAgentCall(req)
        ? json([['unknown-id', '???']]) // id 不在输入 → 0 对齐
        : json([['1', '一'], ['2', '二'], ['3', '三'], ['4', '四']]),
    );
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fellBackToBasic).toBe(true);
    expect(result.fallbackReason).toBe('empty_result');
    expect(result.translated.size).toBe(4);
    expect(parseUser(calls[1]!).length).toBe(4); // 全量重发
  });

  it('alignment_failure (partial): keeps agent successes, resends ONLY missing in basic', async () => {
    const { engine, calls } = makeEngine((req) => {
      if (isAgentCall(req)) {
        // agent 只回 3/4，缺 id=3
        return json([['1', '一'], ['2', '二'], ['4', '四']]);
      }
      // basic 仅应收到缺段 id=3
      const sent = parseUser(req);
      expect(sent.map((s) => s.id)).toEqual(['3']);
      return json([['3', '三']]);
    });
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fellBackToBasic).toBe(true);
    expect(result.fallbackReason).toBe('alignment_failure');
    expect(result.failedIds).toEqual([]);
    // agent 的 3 段保留 + basic 的 1 段
    expect(result.translated.get('1')).toBe('一');
    expect(result.translated.get('2')).toBe('二');
    expect(result.translated.get('3')).toBe('三');
    expect(result.translated.get('4')).toBe('四');
    expect(calls.length).toBe(2);
    // ★ 已成功段不重发：basic 调用只含 id=3
    expect(parseUser(calls[1]!).map((s) => s.id)).toEqual(['3']);
  });

  it('basic fallback also fails → remaining items become failedIds', async () => {
    const { engine } = makeEngine(() => 'not json');
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fellBackToBasic).toBe(true);
    expect(result.fallbackReason).toBe('parse_error');
    expect(result.failedIds).toEqual(['1', '2', '3', '4']);
    expect(result.translated.size).toBe(0);
  });

  it('basic fallback partial → only still-missing become failedIds', async () => {
    const { engine } = makeEngine((req) =>
      isAgentCall(req)
        ? 'not json'
        : json([['1', '一'], ['2', '二']]), // basic 也只回 2/4
    );
    const result = await runAgentBatch({
      items,
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.fallbackReason).toBe('parse_error');
    expect(result.translated.get('1')).toBe('一');
    expect(result.translated.get('2')).toBe('二');
    expect(result.failedIds).toEqual(['3', '4']);
  });

  it('empty items → empty result, no engine call', async () => {
    const { engine, calls } = makeEngine(() => json([]));
    const result = await runAgentBatch({
      items: [],
      agent: agentInput(),
      targetLang: '简体中文',
      engine,
    });

    expect(result.translated.size).toBe(0);
    expect(result.failedIds).toEqual([]);
    expect(result.fellBackToBasic).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('throws AbortError when signal already aborted (no engine call, no fallback)', async () => {
    const { engine, calls } = makeEngine(() => json([]));
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      runAgentBatch({
        items,
        agent: agentInput(),
        targetLang: '简体中文',
        engine,
        signal: ctrl.signal,
      }),
    ).rejects.toThrow(/aborted|AbortError/i);
    expect(calls.length).toBe(0);
  });

  it('respects targetLang in both agent and basic prompts', async () => {
    const { engine, calls } = makeEngine(() =>
      json([['1', '一'], ['2', '二'], ['3', '三'], ['4', '四']]),
    );
    await runAgentBatch({
      items,
      agent: agentInput({ targetLang: '日本語' }),
      targetLang: '日本語',
      engine,
    });
    expect(calls[0]!.targetLang).toBe('日本語');
  });
});
