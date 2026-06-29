import { describe, expect, it } from 'vitest';
import { TaskQueue } from './queue';
import { ConcurrencyController } from './concurrency-controller';
import type { ConcurrencyController as ControllerType } from './concurrency-controller';
import type { QueueResult } from './queue';

async function flush(n = 30): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('TaskQueue - basic API', () => {
  it('enqueue / size / enqueueAll / clear', () => {
    const q = new TaskQueue();
    expect(q.size).toBe(0);
    expect(q.isDraining).toBe(false);

    q.enqueue({ id: 'a', run: async () => 1 });
    expect(q.size).toBe(1);

    q.enqueueAll([
      { id: 'b', run: async () => 2 },
      { id: 'c', run: async () => 3 },
    ]);
    expect(q.size).toBe(3);

    q.clear();
    expect(q.size).toBe(0);
  });
});

describe('TaskQueue - drain respects controller concurrency', () => {
  it('keeps in-flight ≤ maxConcurrent across 6 tasks (maxConcurrent=2)', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 2, rps: 1000 });
    const q = new TaskQueue<number>();
    const holders = Array.from({ length: 6 }, () => defer());
    let active = 0;
    let peak = 0;
    const results: QueueResult[] = [];

    holders.forEach((h, i) => {
      q.enqueue({
        id: String(i),
        run: async () => {
          active++;
          peak = Math.max(peak, active);
          await h.promise;
          active--;
          return i;
        },
      });
    });

    const drainP = q.drain(c, { onResult: (r) => results.push(r) });

    await flush();
    expect(peak).toBe(2);
    expect(c.inFlight).toBe(2);
    expect(q.isDraining).toBe(true);

    for (const h of holders) h.resolve();
    await drainP;

    expect(results).toHaveLength(6);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBe(2);
    expect(q.size).toBe(0);
    expect(c.inFlight).toBe(0);
  });

  it('dispatches higher priority first (maxConcurrent=1)', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 1, rps: 1000 });
    const q = new TaskQueue<string>();
    const hold = { a: defer(), b: defer(), c: defer() };
    const order: string[] = [];

    q.enqueue({ id: 'a', priority: 1, run: async () => { order.push('a-start'); await hold.a.promise; order.push('a-done'); return 'a'; } });
    q.enqueue({ id: 'b', priority: 10, run: async () => { order.push('b-start'); await hold.b.promise; order.push('b-done'); return 'b'; } });
    q.enqueue({ id: 'c', priority: 5, run: async () => { order.push('c-start'); await hold.c.promise; order.push('c-done'); return 'c'; } });

    const drainP = q.drain(c);
    await flush();
    expect(order).toEqual(['b-start']); // highest priority first

    hold.b.resolve();
    await flush();
    expect(order).toEqual(['b-start', 'b-done', 'c-start']); // c (prio 5) before a (prio 1)

    hold.c.resolve();
    await flush();
    expect(order).toEqual(['b-start', 'b-done', 'c-start', 'c-done', 'a-start']);

    hold.a.resolve();
    await drainP;
    expect(order).toEqual(['b-start', 'b-done', 'c-start', 'c-done', 'a-start', 'a-done']);
  });

  it('isolates per-task failures (drain resolves, failing task marked ok=false)', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 3, rps: 1000 });
    const q = new TaskQueue<number>();
    q.enqueue({ id: 'ok1', run: async () => 1 });
    q.enqueue({ id: 'boom', run: async () => { throw new Error('kaboom'); } });
    q.enqueue({ id: 'ok2', run: async () => 2 });

    const onResult: QueueResult[] = [];
    const results = await q.drain(c, { onResult: (r) => onResult.push(r) });

    expect(results).toHaveLength(3);
    const boom = results.find((r) => r.id === 'boom');
    expect(boom?.ok).toBe(false);
    expect(boom?.error).toBeInstanceOf(Error);
    const ok = results.filter((r) => r.ok).map((r) => r.value);
    expect(ok).toEqual([1, 2]);
    expect(onResult).toHaveLength(3);
  });

  it('forwards cost to controller.acquire', async () => {
    const calls: number[] = [];
    const stub = {
      acquire: async (cost?: number) => {
        calls.push(cost ?? 1);
      },
      release: () => {},
    } as unknown as ControllerType;

    const q = new TaskQueue();
    q.enqueue({ id: 'big', cost: 7, run: async () => undefined });
    q.enqueue({ id: 'def', run: async () => undefined }); // default cost 1
    await q.drain(stub);

    expect(calls).toContain(7);
    expect(calls).toContain(1);
  });

  it('rejects re-entrant drain while already draining', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 1, rps: 1000 });
    const q = new TaskQueue();
    const hold = defer();
    q.enqueue({ id: 'a', run: async () => { await hold.promise; } });

    const d1 = q.drain(c);
    await flush();
    expect(q.isDraining).toBe(true);
    await expect(q.drain(c)).rejects.toThrow(/already draining/);

    hold.resolve();
    await d1;
  });
});
