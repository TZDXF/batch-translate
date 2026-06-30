/**
 * recovery.ts 测试 —— 队列持久化 + chrome.alarms 恢复。
 *
 * 覆盖任务 TRA-11 验收点：批次落盘 / 恢复续传、幂等不重翻、alarm 触发恢复、过期批次清理。
 * 全程用 fake chrome（storage.local / alarms / runtime）隔离真实扩展 API。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  batchStorageKey,
  createBatchState,
  saveBatchState,
  loadBatchState,
  removeBatchState,
  listBatchStates,
  listUnfinishedBatches,
  getActiveBatchForTab,
  isBatchFinished,
  missingIdsOf,
  recordItemDone,
  recordItemFailed,
  bumpAttempts,
  markBatchStatus,
  completeBatch,
  pruneStaleBatches,
  recoverOnce,
  resumeForTab,
  setupRecovery,
} from '../recovery';
import type {
  PersistedBatchState,
  RecoveryDeps,
  ResumeOutcome,
  ResumePort,
} from '../recovery';
import type { Item } from '../../shared/types';
import { RECOVERY_ALARM_NAME, RECOVERY_ALARM_PERIOD_MIN } from '../../shared/constants';

// ─── 固定时钟 ──────────────────────────────────────────────────────────────
const NOW = 1_700_000_000_000;

// ─── fake chrome.event（addListener / removeListener / fire） ───────────────
function makeEvent<Args extends unknown[]>() {
  const listeners: Array<(...args: Args) => void> = [];
  return {
    addListener: (cb: (...args: Args) => void) => {
      listeners.push(cb);
    },
    removeListener: (cb: (...args: Args) => void) => {
      const i = listeners.indexOf(cb);
      if (i >= 0) listeners.splice(i, 1);
    },
    fire: (...args: Args) => {
      for (const l of [...listeners]) l(...args);
    },
    size: () => listeners.length,
  };
}

// ─── fake chrome.storage.local（Map 后端 + 异步回调） ────────────────────────
function makeStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    local: {
      get: (
        keys: string | string[] | null,
        cb: (items: Record<string, unknown>) => void,
      ) => {
        const out: Record<string, unknown> = {};
        if (keys === null) {
          for (const [k, v] of store) out[k] = v;
        } else {
          const arr = Array.isArray(keys) ? keys : [keys];
          for (const k of arr) if (store.has(k)) out[k] = store.get(k);
        }
        queueMicrotask(() => cb(out));
      },
      set: (items: Record<string, unknown>, cb: () => void) => {
        for (const [k, v] of Object.entries(items)) store.set(k, v);
        queueMicrotask(() => cb());
      },
      remove: (keys: string | string[], cb: () => void) => {
        const arr = Array.isArray(keys) ? keys : [keys];
        for (const k of arr) store.delete(k);
        queueMicrotask(() => cb());
      },
    },
  };
}

// ─── fake chrome.alarms ─────────────────────────────────────────────────────
function makeAlarms() {
  const alarms = new Map<string, { periodInMinutes?: number; delayInMinutes?: number }>();
  const onAlarm = makeEvent<[{ name: string }]>();
  return {
    map: alarms,
    create: (
      name: string,
      info: { periodInMinutes?: number; delayInMinutes?: number },
    ) => {
      alarms.set(name, info);
    },
    clear: (name: string, cb: (wasCleared: boolean) => void) => {
      const had = alarms.delete(name);
      queueMicrotask(() => cb(had));
    },
    onAlarm,
  };
}

// ─── 装配 globalThis.chrome ──────────────────────────────────────────────────
interface FakeChrome {
  storage: ReturnType<typeof makeStorage>;
  alarms: ReturnType<typeof makeAlarms>;
  runtime: {
    onStartup: ReturnType<typeof makeEvent<[]>>;
    onInstalled: ReturnType<typeof makeEvent<[unknown]>>;
  };
}

function installFakeChrome(): FakeChrome {
  const storage = makeStorage();
  const alarms = makeAlarms();
  const runtime = {
    onStartup: makeEvent<[]>(),
    onInstalled: makeEvent<[unknown]>(),
  };
  const fake: FakeChrome = { storage, alarms, runtime };
  (globalThis as { chrome?: unknown }).chrome = fake;
  return fake;
}

// ─── 样本构造 ───────────────────────────────────────────────────────────────
function items(...ids: string[]): Item[] {
  return ids.map((id) => ({ id, text: `text-${id}` }));
}

function makeBatch(
  over: Partial<PersistedBatchState> & { batchId: string },
): PersistedBatchState {
  const base = createBatchState({
    batchId: over.batchId,
    tabId: over.tabId ?? 1,
    items: over.items ?? items('a', 'b', 'c'),
    ctx: over.ctx ?? {
      engineId: 'e1',
      targetLang: 'zh',
      sourceLang: 'auto',
      mode: 'basic',
      promptFingerprint: 'fp',
    },
    now: over.createdAt ?? NOW,
  });
  return {
    ...base,
    items: over.items ?? base.items,
    doneIds: over.doneIds ?? [],
    failedIds: over.failedIds ?? [],
    attempts: over.attempts ?? 0,
    status: over.status ?? 'pending',
    createdAt: over.createdAt ?? NOW,
    updatedAt: over.updatedAt ?? NOW,
    ctx: over.ctx ?? base.ctx,
    tabId: over.tabId ?? 1,
  };
}

/** 记录调用的 fake ResumePort；默认每段都成功（remainingMissing=[]）。 */
function makeResumePort(
  impl?: (s: PersistedBatchState) => ResumeOutcome | Promise<ResumeOutcome>,
): ResumePort & { calls: PersistedBatchState[] } {
  const calls: PersistedBatchState[] = [];
  return {
    calls,
    resume: async (s) => {
      calls.push(s);
      return impl ? await impl(s) : { batchId: s.batchId, remainingMissing: [] };
    },
  };
}

function makeDeps(
  over: Partial<RecoveryDeps> & { resumePort: ResumePort },
): RecoveryDeps {
  return {
    resumePort: over.resumePort,
    tabLookup: over.tabLookup ?? (() => true),
    now: over.now ?? (() => NOW),
    staleAfterMs: over.staleAfterMs,
    maxAttempts: over.maxAttempts,
    logger: over.logger,
    inFlight: over.inFlight,
  };
}

/** 手动控制的延迟 promise（模拟慢 resume）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * 排空微任务队列。setupRecovery 的 alarm / startup 钩子内 recoverOnce 是 fire-and-forget，
 * 经多层 storage（每层 queueMicrotask）+ resume 才完成；需要足够多的微任务轮次才能排空。
 */
async function flush(ticks = 30): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

// ════════════════════════════════════════════════════════════════════════
// 测试
// ════════════════════════════════════════════════════════════════════════

describe('recovery — storage key', () => {
  it('batchStorageKey 采用 config.queue.<batchId> 扁平命名', () => {
    expect(batchStorageKey('b1')).toBe('config.queue.b1');
    expect(batchStorageKey('tab-7-batch-3')).toBe('config.queue.tab-7-batch-3');
  });
});

describe('recovery — 持久化 CRUD', () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('saveBatchState / loadBatchState 往返一致', async () => {
    const state = makeBatch({ batchId: 'b1', doneIds: ['a'] });
    await saveBatchState(state);
    const loaded = await loadBatchState('b1');
    expect(loaded).toEqual(state);
    // 确实写到了扁平键
    expect(fake.storage.store.get('config.queue.b1')).toEqual(state);
  });

  it('loadBatchState 不存在返回 undefined', async () => {
    expect(await loadBatchState('nope')).toBeUndefined();
  });

  it('loadBatchState 拒绝污染 / 残缺的值', async () => {
    fake.storage.store.set('config.queue.bad1', { foo: 'bar' });
    fake.storage.store.set('config.queue.bad2', 'not-an-object');
    expect(await loadBatchState('bad1')).toBeUndefined();
    expect(await loadBatchState('bad2')).toBeUndefined();
  });

  it('removeBatchState 删除指定批次', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1' }));
    await removeBatchState('b1');
    expect(await loadBatchState('b1')).toBeUndefined();
  });

  it('listBatchStates 只列出队列键，忽略 config 等其他 storage 键', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1' }));
    await saveBatchState(makeBatch({ batchId: 'b2', tabId: 2 }));
    fake.storage.store.set('config', { version: 1 }); // 主 config 对象，应被忽略
    fake.storage.store.set('__mk', 'master-key'); // 加密主密钥键，应被忽略
    const all = await listBatchStates();
    expect(all.map((s) => s.batchId).sort()).toEqual(['b1', 'b2']);
  });

  it('listBatchStates 跳过非法队列键', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1' }));
    fake.storage.store.set('config.queue.garbage', { nope: true });
    const all = await listBatchStates();
    expect(all).toHaveLength(1);
    expect(all[0]!.batchId).toBe('b1');
  });

  it('listUnfinishedBatches 只返回 pending / in_progress', async () => {
    await saveBatchState(makeBatch({ batchId: 'a', status: 'pending' }));
    await saveBatchState(makeBatch({ batchId: 'b', status: 'in_progress' }));
    await saveBatchState(makeBatch({ batchId: 'c', status: 'done' }));
    await saveBatchState(makeBatch({ batchId: 'd', status: 'failed' }));
    await saveBatchState(makeBatch({ batchId: 'e', status: 'cancelled' }));
    const unfinished = await listUnfinishedBatches();
    expect(unfinished.map((s) => s.batchId).sort()).toEqual(['a', 'b']);
  });

  it('getActiveBatchForTab 命中该 tab 的未完成批次', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 7, status: 'in_progress' }));
    await saveBatchState(makeBatch({ batchId: 'b2', tabId: 8, status: 'pending' }));
    await saveBatchState(makeBatch({ batchId: 'b3', tabId: 7, status: 'done' }));
    const got = await getActiveBatchForTab(7);
    expect(got?.batchId).toBe('b1');
    expect(await getActiveBatchForTab(99)).toBeUndefined();
  });
});

describe('recovery — 派生计算（纯函数）', () => {
  it('isBatchFinished：所有 item 在 done 或 failed 内即为结算', () => {
    const its = items('a', 'b', 'c');
    expect(isBatchFinished({ batchId: 'b', tabId: 1, items: its, doneIds: [], failedIds: [], attempts: 0 })).toBe(false);
    expect(isBatchFinished({ batchId: 'b', tabId: 1, items: its, doneIds: ['a', 'b'], failedIds: [], attempts: 0 })).toBe(false);
    expect(isBatchFinished({ batchId: 'b', tabId: 1, items: its, doneIds: ['a', 'b'], failedIds: ['c'], attempts: 0 })).toBe(true);
    expect(isBatchFinished({ batchId: 'b', tabId: 1, items: its, doneIds: [], failedIds: ['a', 'b', 'c'], attempts: 0 })).toBe(true);
  });

  it('missingIdsOf：不在 done 也不在 failed 的 id', () => {
    const its = items('a', 'b', 'c', 'd');
    const state = { batchId: 'b', tabId: 1, items: its, doneIds: ['a'], failedIds: ['d'], attempts: 0 };
    expect(missingIdsOf(state).sort()).toEqual(['b', 'c']);
  });
});

describe('recovery — 增量落盘', () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('recordItemDone 去重、移出 failed、翻 done；返回更新态', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', items: items('a', 'b'), failedIds: ['a'] }));
    const next = await recordItemDone('b1', 'a', NOW + 10);
    expect(next?.doneIds).toEqual(['a']);
    expect(next?.failedIds).toEqual([]); // 从 failed 移除
    expect(next?.status).toBe('in_progress');
    expect(next?.updatedAt).toBe(NOW + 10);

    const done2 = await recordItemDone('b1', 'b', NOW + 20);
    expect(done2?.doneIds.sort()).toEqual(['a', 'b']);
    expect(done2?.status).toBe('done'); // 全部完成 → done
  });

  it('recordItemDone 幂等（重复 id 不重复计入）', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', items: items('a', 'b') }));
    await recordItemDone('b1', 'a');
    await recordItemDone('b1', 'a');
    const s = await loadBatchState('b1');
    expect(s?.doneIds).toEqual(['a']);
  });

  it('recordItemDone 对不存在批次返回 undefined', async () => {
    expect(await recordItemDone('ghost', 'a')).toBeUndefined();
  });

  it('recordItemFailed 加入 failed、不去覆盖 done、全部结算翻 failed', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', items: items('a', 'b'), doneIds: ['a'] }));
    const next = await recordItemFailed('b1', 'b');
    expect(next?.failedIds).toEqual(['b']);
    expect(next?.status).toBe('failed'); // a done + b failed = 全结算
    // 已 done 的不再标失败
    const noop = await recordItemFailed('b1', 'a');
    const s = await loadBatchState('b1');
    expect(s?.doneIds).toEqual(['a']);
    expect(s?.failedIds).toEqual(['b']);
    expect(noop?.status).toBe('failed');
  });

  it('bumpAttempts 自增并刷新 updatedAt', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', attempts: 2 }));
    const next = await bumpAttempts('b1', NOW + 5);
    expect(next?.attempts).toBe(3);
    expect(next?.updatedAt).toBe(NOW + 5);
  });

  it('markBatchStatus 改状态', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', status: 'in_progress' }));
    const next = await markBatchStatus('b1', 'cancelled');
    expect(next?.status).toBe('cancelled');
  });

  it('completeBatch 移除批次', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1' }));
    await completeBatch('b1');
    expect(await loadBatchState('b1')).toBeUndefined();
  });

  it('同批并发 recordItemDone 经串行锁不丢更新', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', items: items('a', 'b', 'c') }));
    // 并发两段同时完成：无锁会读改写竞争丢一段
    await Promise.all([
      recordItemDone('b1', 'a'),
      recordItemDone('b1', 'b'),
      recordItemDone('b1', 'c'),
    ]);
    const s = await loadBatchState('b1');
    expect(s?.doneIds.sort()).toEqual(['a', 'b', 'c']);
    expect(s?.status).toBe('done');
  });
});

describe('recovery — 过期 / 孤儿清理', () => {
  beforeEach(() => installFakeChrome());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('清理终态残留（done / failed / cancelled）', async () => {
    await saveBatchState(makeBatch({ batchId: 'd', status: 'done' }));
    await saveBatchState(makeBatch({ batchId: 'f', status: 'failed' }));
    await saveBatchState(makeBatch({ batchId: 'c', status: 'cancelled' }));
    await saveBatchState(makeBatch({ batchId: 'p', status: 'in_progress' }));
    const { pruned } = await pruneStaleBatches(makeDeps({ resumePort: makeResumePort() }));
    expect(pruned).toBe(3);
    const remain = await listBatchStates();
    expect(remain.map((s) => s.batchId)).toEqual(['p']);
  });

  it('清理超过重试上限的批次', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', attempts: 5, status: 'in_progress' }));
    const { pruned } = await pruneStaleBatches(
      makeDeps({ resumePort: makeResumePort(), maxAttempts: 5 }),
    );
    expect(pruned).toBe(1);
    expect(await loadBatchState('b1')).toBeUndefined();
  });

  it('清理长期孤儿（超期且 tab 未连接）', async () => {
    await saveBatchState(
      makeBatch({ batchId: 'b1', updatedAt: NOW - 10_000, status: 'in_progress' }),
    );
    const { pruned } = await pruneStaleBatches(
      makeDeps({
        resumePort: makeResumePort(),
        tabLookup: () => false, // tab 未连接
        staleAfterMs: 5_000,
      }),
    );
    expect(pruned).toBe(1);
  });

  it('保留超期但 tab 仍连接的批次（可能正续传）', async () => {
    await saveBatchState(
      makeBatch({ batchId: 'b1', updatedAt: NOW - 10_000, status: 'in_progress' }),
    );
    const { pruned } = await pruneStaleBatches(
      makeDeps({
        resumePort: makeResumePort(),
        tabLookup: () => true, // tab 已连接
        staleAfterMs: 5_000,
      }),
    );
    expect(pruned).toBe(0);
    expect(await loadBatchState('b1')).toBeDefined();
  });

  it('保留未超期的活跃批次', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', updatedAt: NOW, status: 'in_progress' }));
    const { pruned } = await pruneStaleBatches(
      makeDeps({ resumePort: makeResumePort(), staleAfterMs: 60_000 }),
    );
    expect(pruned).toBe(0);
  });
});

describe('recovery — recoverOnce 续传', () => {
  beforeEach(() => installFakeChrome());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('tab 已连接的未完成批次触发 resume，完成则移除', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 7, items: items('a', 'b') }));
    const port = makeResumePort(); // 默认全部成功
    const res = await recoverOnce(makeDeps({ resumePort: port, tabLookup: (t) => t === 7 }));
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.batchId).toBe('b1');
    expect(res).toEqual({ scanned: 1, resumed: 1, completed: 1, pruned: 0 });
    expect(await loadBatchState('b1')).toBeUndefined(); // 完成已移除
  });

  it('resume 仍有 missing → 不移除、bump 尝试计数', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', doneIds: ['a'], items: items('a', 'b') }));
    const port = makeResumePort((s) => ({
      batchId: s.batchId,
      remainingMissing: ['b'], // 仍缺 b
    }));
    const res = await recoverOnce(makeDeps({ resumePort: port }));
    expect(res.completed).toBe(0);
    const s = await loadBatchState('b1');
    expect(s?.attempts).toBe(1);
    expect(s?.status).toBe('in_progress');
  });

  it('content 未连接的批次跳过，不调 resume（无 port 回传无意义）', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 7 }));
    const port = makeResumePort();
    const res = await recoverOnce(makeDeps({ resumePort: port, tabLookup: () => false }));
    expect(port.calls).toHaveLength(0);
    expect(res.resumed).toBe(0);
    expect(await loadBatchState('b1')).toBeDefined(); // 保留等重连
  });

  it('resume 抛错不阻塞其它批次，且 bump 尝试计数', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 1 }));
    await saveBatchState(makeBatch({ batchId: 'b2', tabId: 2 }));
    const port = makeResumePort((s) => {
      if (s.batchId === 'b1') throw new Error('boom');
      return { batchId: s.batchId, remainingMissing: [] };
    });
    const res = await recoverOnce(makeDeps({ resumePort: port }));
    expect(res.resumed).toBe(2);
    expect(res.completed).toBe(1); // 只有 b2 完成
    expect((await loadBatchState('b1'))?.attempts).toBe(1);
  });

  it('幂等去重：并发两次 recoverOnce 同一批只 resume 一次（共享 inFlight）', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 1 }));
    const gate = deferred<ResumeOutcome>();
    const port = makeResumePort(() => gate.promise); // 慢 resume
    const inFlight = new Set<string>();
    const deps = makeDeps({ resumePort: port, inFlight });
    const p1 = recoverOnce(deps);
    const p2 = recoverOnce(deps);
    // 让两次扫描都进入循环后再放行
    gate.resolve({ batchId: 'b1', remainingMissing: [] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(port.calls).toHaveLength(1); // 只 resume 一次
    const totalResumed = r1.resumed + r2.resumed;
    expect(totalResumed).toBe(1);
  });

  it('先清理后续传：过期孤儿批次被 prune，不再 resume', async () => {
    await saveBatchState(
      makeBatch({ batchId: 'stale', tabId: 9, updatedAt: NOW - 10_000, status: 'in_progress' }),
    );
    await saveBatchState(makeBatch({ batchId: 'live', tabId: 1 }));
    const port = makeResumePort();
    const res = await recoverOnce(
      makeDeps({
        resumePort: port,
        tabLookup: (t) => t !== 9, // stale 的 tab 未连接
        staleAfterMs: 5_000,
      }),
    );
    expect(res.pruned).toBe(1);
    expect(port.calls.map((s) => s.batchId)).toEqual(['live']);
    expect(await loadBatchState('stale')).toBeUndefined();
  });
});

describe('recovery — resumeForTab（content 重连）', () => {
  beforeEach(() => installFakeChrome());
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('返回已 done 的 id 供 content 去重，并触发 resume', async () => {
    await saveBatchState(
      makeBatch({ batchId: 'b1', tabId: 7, items: items('a', 'b', 'c'), doneIds: ['a'] }),
    );
    const port = makeResumePort();
    const res = await resumeForTab(7, makeDeps({ resumePort: port }));
    expect(res?.batchId).toBe('b1');
    expect(res?.doneIds).toEqual(['a']); // content 据此不重复注入 a
    expect(res?.resumed).toBe(true);
    expect(port.calls).toHaveLength(1);
  });

  it('无在途批次返回 undefined', async () => {
    const port = makeResumePort();
    expect(await resumeForTab(99, makeDeps({ resumePort: port }))).toBeUndefined();
    expect(port.calls).toHaveLength(0);
  });

  it('已在续传中（inFlight）→ resumed=false，不重复 resume', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 7 }));
    const port = makeResumePort();
    const inFlight = new Set<string>(['b1']);
    const res = await resumeForTab(7, makeDeps({ resumePort: port, inFlight }));
    expect(res?.resumed).toBe(false);
    expect(port.calls).toHaveLength(0);
  });
});

describe('recovery — setupRecovery 装配', () => {
  let fake: FakeChrome;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('创建周期 alarm（30s）并注册 onAlarm / onStartup / onInstalled', () => {
    const handle = setupRecovery(makeDeps({ resumePort: makeResumePort() }));
    expect(fake.alarms.map.get(RECOVERY_ALARM_NAME)).toEqual({
      periodInMinutes: RECOVERY_ALARM_PERIOD_MIN,
    });
    expect(fake.alarms.onAlarm.size()).toBe(1);
    expect(fake.runtime.onStartup.size()).toBe(1);
    expect(fake.runtime.onInstalled.size()).toBe(1);
    // 手动触发 recover 可用
    expect(typeof handle.recover).toBe('function');
    return handle.teardown();
  });

  it('匹配名的 alarm 触发 recoverOnce → resume 被调用；非匹配名忽略', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 1 }));
    const port = makeResumePort();
    const handle = setupRecovery(makeDeps({ resumePort: port }));
    // 非匹配名：忽略
    fake.alarms.onAlarm.fire({ name: 'some-other-alarm' });
    expect(port.calls).toHaveLength(0);
    // 匹配名：触发恢复
    fake.alarms.onAlarm.fire({ name: RECOVERY_ALARM_NAME });
    await flush();
    expect(port.calls).toHaveLength(1);
    await handle.teardown();
  });

  it('onStartup / onInstalled 触发恢复', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 1 }));
    // 用「不完成」的 resume，使批次存活，验证两次钩子各触发一次 recoverOnce
    const port = makeResumePort((s) => ({ batchId: s.batchId, remainingMissing: ['x'] }));
    const handle = setupRecovery(makeDeps({ resumePort: port }));
    fake.runtime.onStartup.fire();
    await flush();
    expect(port.calls).toHaveLength(1);
    fake.runtime.onInstalled.fire({ reason: 'install' });
    await flush();
    expect(port.calls).toHaveLength(2);
    await handle.teardown();
  });

  it('teardown 移除全部监听器并清除 alarm', async () => {
    const handle = setupRecovery(makeDeps({ resumePort: makeResumePort() }));
    await handle.teardown();
    expect(fake.alarms.onAlarm.size()).toBe(0);
    expect(fake.runtime.onStartup.size()).toBe(0);
    expect(fake.runtime.onInstalled.size()).toBe(0);
    expect(fake.alarms.map.has(RECOVERY_ALARM_NAME)).toBe(false);
  });

  it('alarm fire 在 teardown 后不再触发 resume', async () => {
    await saveBatchState(makeBatch({ batchId: 'b1', tabId: 1 }));
    const port = makeResumePort();
    const handle = setupRecovery(makeDeps({ resumePort: port }));
    await handle.teardown();
    fake.alarms.onAlarm.fire({ name: RECOVERY_ALARM_NAME });
    await flush();
    expect(port.calls).toHaveLength(0);
  });
});
