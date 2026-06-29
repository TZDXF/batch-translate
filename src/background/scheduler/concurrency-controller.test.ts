import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ConcurrencyController } from './concurrency-controller';

/** Flush pending microtasks (gate/bucket awaits resolve via microtasks, not timers). */
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

describe('ConcurrencyController - construction & validation', () => {
  it('rejects maxConcurrent < 1', () => {
    expect(() => new ConcurrencyController({ maxConcurrent: 0 })).toThrow(RangeError);
  });

  it('rejects rps <= 0', () => {
    expect(() => new ConcurrencyController({ rps: 0 })).toThrow(RangeError);
    expect(() => new ConcurrencyController({ rps: -1 })).toThrow(RangeError);
  });

  it('exposes initial state', () => {
    const c = new ConcurrencyController({ maxConcurrent: 3, rps: 2 });
    expect(c.inFlight).toBe(0);
    expect(c.effectiveRps).toBe(2);
    expect(c.availableRpsTokens).toBe(2); // capacity = rps
  });
});

describe('ConcurrencyController - bounded concurrency (acceptance: ≤ maxConcurrent in flight)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('never exceeds maxConcurrent=3 across 50 concurrent tasks', async () => {
    // rps high so the token bucket never blocks — we are isolating the concurrency gate.
    const c = new ConcurrencyController({ maxConcurrent: 3, rps: 1000 });
    const N = 50;
    const holders = Array.from({ length: N }, () => defer());
    let active = 0;
    let peak = 0;
    const entered: number[] = [];

    const promises = holders.map((h, i) =>
      (async () => {
        await c.acquire();
        active++;
        expect(active).toBeLessThanOrEqual(3);
        peak = Math.max(peak, active);
        entered.push(i);
        await h.promise;
        active--;
        c.release();
      })(),
    );

    await flush();
    // Only the first 3 should hold slots; the rest queue on the gate.
    expect(entered).toHaveLength(3);
    expect(c.inFlight).toBe(3);
    expect(peak).toBe(3);

    // Release everyone; gate hands slots off one-for-one, never exceeding 3.
    for (const h of holders) h.resolve();
    await Promise.all(promises);

    expect(entered).toHaveLength(N);
    expect(peak).toBe(3);
    expect(c.inFlight).toBe(0);
  });

  it('serializes at maxConcurrent=1 (strict handoff)', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 1, rps: 1000 });
    const order: string[] = [];
    const holdA = defer();

    const a = (async () => {
      await c.acquire();
      order.push('a-in');
      await holdA.promise;
      order.push('a-out');
      c.release();
    })();

    await flush();
    expect(c.inFlight).toBe(1);

    let bEntered = false;
    const b = (async () => {
      await c.acquire();
      bEntered = true;
      order.push('b-in');
      c.release();
    })();

    await flush();
    expect(bEntered).toBe(false); // 'b' waits behind 'a'

    holdA.resolve(); // 'a' finishes and releases -> gate hands slot to 'b'
    await Promise.all([a, b]);

    expect(bEntered).toBe(true);
    expect(order).toEqual(['a-in', 'a-out', 'b-in']);
    expect(c.inFlight).toBe(0);
  });
});

describe('ConcurrencyController - token bucket (RPS) burst & refill', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a burst of `rps` then rate-limits (补桶 after wait)', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 10, rps: 2 });
    const done = [false, false, false];
    c.acquire().then(() => (done[0] = true));
    c.acquire().then(() => (done[1] = true));
    c.acquire().then(() => (done[2] = true)); // 3rd must wait for refill

    await flush();
    expect(done).toEqual([true, true, false]); // burst = 2
    expect(c.inFlight).toBe(3); // all 3 hold slots; 3rd is rate-blocked

    // need 1 token at 2 tokens/sec => 500ms
    await vi.advanceTimersByTimeAsync(499);
    await flush();
    expect(done[2]).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(done[2]).toBe(true);
  });

  it('refills back to burst capacity after idle', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 10, rps: 2 });
    // drain burst
    const d1 = [false, false];
    c.acquire().then(() => (d1[0] = true));
    c.acquire().then(() => (d1[1] = true));
    await flush();
    expect(d1).toEqual([true, true]);

    // idle 1s -> fully refilled to capacity 2
    await vi.advanceTimersByTimeAsync(1000);

    const d2 = [false, false, false];
    c.acquire().then(() => (d2[0] = true));
    c.acquire().then(() => (d2[1] = true));
    c.acquire().then(() => (d2[2] = true));
    await flush();
    expect(d2).toEqual([true, true, false]); // burst of 2 again after refill
  });
});

describe('ConcurrencyController - TPM bucket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rate-limits by token cost per minute', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 10, rps: 1000, tpmLimit: 600 });
    const done = [false, false, false];
    c.acquire(300).then(() => (done[0] = true));
    c.acquire(300).then(() => (done[1] = true));
    c.acquire(300).then(() => (done[2] = true)); // needs 300 more; waits 30s

    await flush();
    expect(done).toEqual([true, true, false]);

    // 300 tokens at 600/min (0.01/ms) => 30000ms
    await vi.advanceTimersByTimeAsync(29999);
    await flush();
    expect(done[2]).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(done[2]).toBe(true);
  });

  it('drains the bucket immediately when a single cost exceeds capacity', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 10, rps: 1000, tpmLimit: 100 });
    let big = false;
    let small = false;
    c.acquire(150).then(() => (big = true)); // 150 > capacity 100 -> drain, immediate
    c.acquire(10).then(() => (small = true)); // now empty -> waits

    await flush();
    expect(big).toBe(true);
    expect(small).toBe(false);

    // 10 tokens at 100/min => 6000ms
    await vi.advanceTimersByTimeAsync(6000);
    await flush();
    expect(small).toBe(true);
  });

  it('treats cost <= 0 on TPM as a no-op consume', async () => {
    const c = new ConcurrencyController({ maxConcurrent: 10, rps: 1000, tpmLimit: 100 });
    let done = false;
    c.acquire(0).then(() => (done = true));
    await flush();
    expect(done).toBe(true);
  });
});

describe('ConcurrencyController - AIMD throttle & recovery', () => {
  it('halves RPS on throttle (floored at minRps) and restores after N successes', () => {
    const c = new ConcurrencyController({
      maxConcurrent: 3,
      rps: 4,
      aimd: { recoveryThreshold: 3, minRps: 0.5 },
    });
    expect(c.effectiveRps).toBe(4);

    c.recordThrottle();
    expect(c.effectiveRps).toBe(2);
    c.recordThrottle();
    expect(c.effectiveRps).toBe(1);
    c.recordThrottle();
    expect(c.effectiveRps).toBe(0.5);
    c.recordThrottle();
    expect(c.effectiveRps).toBe(0.5); // floor

    // recovery: needs 3 consecutive successes
    c.recordSuccess();
    expect(c.effectiveRps).toBe(0.5);
    c.recordSuccess();
    expect(c.effectiveRps).toBe(0.5);
    c.recordSuccess();
    expect(c.effectiveRps).toBe(4); // restored
    c.recordSuccess();
    expect(c.effectiveRps).toBe(4); // already at target, no-op
  });

  it('clamps held tokens when capacity shrinks on throttle', () => {
    const c = new ConcurrencyController({ maxConcurrent: 3, rps: 4 });
    // tokens start at capacity 4
    expect(c.availableRpsTokens).toBe(4);
    c.recordThrottle(); // rps 4 -> 2, capacity -> max(1,2)=2, tokens clamp to <=2
    expect(c.effectiveRps).toBe(2);
    expect(c.availableRpsTokens).toBeLessThanOrEqual(2);
  });
});
