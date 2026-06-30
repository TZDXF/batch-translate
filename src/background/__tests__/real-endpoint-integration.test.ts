/**
 * 真实端点集成测试（P0-12 / TRA-13）：用真实 OpenAI 兼容端点驱动整条翻译流水线，
 * 验证插件确能端到端翻译（区别于 mock-llm 的协议层验证）。
 *
 * 端点配置走环境变量（内网测试端点，非公开）：
 *   BT_REAL_BASE_URL / BT_REAL_API_KEY / BT_REAL_MODEL
 * 任一缺失或端点不可达 → skip（不阻塞 CI；内网环境手测时启用）。
 *
 * 验证：
 *  - 真实翻译：英文段 → 非空译文，与原文不同，含目标语字符。
 *  - 批量合并：多段进，请求数 << 段落数（差异化点）。
 *  - id 对齐：返回 items 一一对齐输入 id。
 *  - 缓存命中：同输入二次翻译请求数为 0。
 */
import { describe, expect, it, beforeAll, afterEach } from 'vitest';
import { createOrchestrator } from '../orchestrator';
import type { OrchestratorDeps, OrchestratorPort, TranslateContext } from '../orchestrator';
import type { SMToContentPortMessage } from '../../shared/messages';
import type { Item } from '../../shared/types';
import { getStage2Modules, computeBudget } from '../runtime-deps';
import { OpenAIEngine } from '../engines/openai';
import type { EngineConfig } from '../../shared/types';

const BASE_URL = process.env.BT_REAL_BASE_URL ?? '';
const API_KEY = process.env.BT_REAL_API_KEY ?? '';
const MODEL = process.env.BT_REAL_MODEL ?? 'auto';

const canRun = !!(BASE_URL && API_KEY);

// 端点连通性预检（避免每个 it 都等超时）。
let endpointReachable = false;
beforeAll(async () => {
  if (!canRun) return;
  try {
    const resp = await fetch(`${BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'reply with the single word: pong' }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(8000),
    });
    endpointReachable = resp.ok;
  } catch {
    endpointReachable = false;
  }
});

const ENGINE_CFG: EngineConfig = {
  id: 'eng-real',
  label: 'real',
  provider: 'openai-compatible',
  baseUrl: BASE_URL,
  model: MODEL,
  enabled: true,
  apiKeyRef: 'ref',
  contextWindow: 128_000,
  maxOutput: 4096,
};

const SCHEDULING = {
  maxConcurrent: 3,
  rps: 2,
  tpmLimit: 0,
  maxRetries: 2,
  itemsPerBatch: 20,
  batchTokenBudgetRatio: 0.7,
};

function makeOrchestratorAndEngine(): { deps: OrchestratorDeps; engine: OpenAIEngine } {
  const mods = getStage2Modules();
  const engine = new OpenAIEngine(ENGINE_CFG, API_KEY);
  const deps: OrchestratorDeps = {
    protocol: mods.protocol,
    packer: mods.packer,
    scheduler: mods.scheduler,
    retry: mods.retry,
    cache: mods.cache,
    broadcastStatus: () => {},
  };
  return { deps, engine };
}

function makeCtx(engine: OpenAIEngine): TranslateContext {
  return {
    tabId: 1,
    engine,
    engineId: engine.id,
    targetLang: 'zh-CN',
    sourceLang: 'auto',
    mode: 'basic',
    scheduling: SCHEDULING,
    budget: computeBudget(ENGINE_CFG, SCHEDULING),
  };
}

function makePort(): { port: OrchestratorPort; messages: SMToContentPortMessage[] } {
  const messages: SMToContentPortMessage[] = [];
  return { port: { postMessage: (m: SMToContentPortMessage) => messages.push(m) }, messages };
}

const resultsOf = (msgs: SMToContentPortMessage[]) =>
  msgs.filter((m): m is { type: 'RESULT'; id: string; translated: string } => m.type === 'RESULT');

const SAMPLE: Item[] = [
  { id: 'p1', text: 'Machine translation converts text from one language to another.' },
  { id: 'p2', text: 'Modern systems use large neural networks for translation.' },
  { id: 'p3', text: 'This approach achieves remarkable accuracy in practice.' },
];

async function clearCache(): Promise<void> {
  const { CacheStore } = await import('../cache/cache-store');
  await new CacheStore().clear();
}

describe.skipIf(!canRun)('真实端点集成（OpenAI 兼容）', () => {
  afterEach(async () => {
    await clearCache();
  });

  it('端点连通 + 真实翻译：英文段 → 中文译文，id 对齐，批量合并', async () => {
    if (!endpointReachable) {
      console.warn('真实端点不可达，skip');
      return;
    }
    const { deps, engine } = makeOrchestratorAndEngine();
    const orch = createOrchestrator(deps);
    const { port, messages } = makePort();

    // 计请求次数：包一层 fetch 计数（engine 内部用 fetch，无法直接拦截，
    // 改用 mock-llm 的请求计数思路不可行；这里用「段落数 vs 是否一次请求」间接断言：
    // 3 段在预算内应合并为 1 批 → 仅 1 次 RESULT 批次。用 BATCH_DONE 计数）。
    await orch.translateBatch(SAMPLE, makeCtx(engine), port);

    const results = resultsOf(messages);
    // 3 段全部回填。
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.id).sort()).toEqual(['p1', 'p2', 'p3']);
    // ★ 真实翻译：译文非空、与原文不同、含中文（目标语 zh-CN）。
    for (const r of results) {
      expect(r.translated.trim().length).toBeGreaterThan(0);
      expect(r.translated).not.toBe(SAMPLE.find((s) => s.id === r.id)!.text);
      // 含至少一个 CJK 字符（译文应是中文）。
      expect(/[一-鿿]/.test(r.translated)).toBe(true);
    }
    // ★ 批量合并：3 段应合并为 1 批（BATCH_DONE 次数 = 1，且无单段重发）。
    const batchDones = messages.filter((m) => m.type === 'BATCH_DONE');
    expect(batchDones.length).toBe(1);
    // 无 ERROR。
    expect(messages.some((m) => m.type === 'ERROR')).toBe(false);
  }, 60000);

  it('缓存命中：同输入二次翻译不重复请求真实端点', async () => {
    if (!endpointReachable) return;
    const { deps, engine } = makeOrchestratorAndEngine();
    const orch = createOrchestrator(deps);

    // 第一次：3 段全 miss → 真实请求 + 写缓存。
    const p1 = makePort();
    await orch.translateBatch(SAMPLE, makeCtx(engine), p1.port);
    expect(resultsOf(p1.messages)).toHaveLength(3);

    // 第二次：同输入同引擎同目标语 → 全命中缓存，不发请求（仅 RESULT 回填）。
    const p2 = makePort();
    await orch.translateBatch(SAMPLE, makeCtx(engine), p2.port);
    const r2 = resultsOf(p2.messages);
    expect(r2).toHaveLength(3);
    // 二次结果与首次一致（缓存命中回填）。
    const byId1 = new Map(resultsOf(p1.messages).map((r) => [r.id, r.translated]));
    for (const r of r2) {
      expect(r.translated).toBe(byId1.get(r.id));
    }
    // 二次无 BATCH_DONE（缓存命中段不发请求 → 不进 scheduleBatch）。
    expect(p2.messages.some((m) => m.type === 'BATCH_DONE')).toBe(false);
  }, 60000);
});
