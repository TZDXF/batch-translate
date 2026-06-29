import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  applyJitter,
  backoff,
  exponentialBase,
  parseRetryAfter,
  withRetry,
} from './retry';
import type { BackoffHeaders, RetryableError, RetryOptions } from './retry';

function httpErr(status: number, headers?: Record<string, string>): RetryableError {
  const err = new Error(`http ${status}`) as RetryableError;
  err.status = status;
  if (headers) {
    const map = headers;
    err.headers = {
      get: (name: string) => {
        const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
        return key ? (map[key] ?? null) : null;
      },
    } satisfies BackoffHeaders;
  }
  return err;
}

describe('exponentialBase', () => {
  it('doubles each attempt and caps at 60s', () => {
    expect(exponentialBase(0)).toBe(1000);
    expect(exponentialBase(1)).toBe(2000);
    expect(exponentialBase(2)).toBe(4000);
    expect(exponentialBase(3)).toBe(8000);
    expect(exponentialBase(4)).toBe(16000);
    expect(exponentialBase(5)).toBe(32000);
    expect(exponentialBase(6)).toBe(60000); // 64000 -> cap
    expect(exponentialBase(7)).toBe(60000);
    expect(exponentialBase(20)).toBe(60000);
  });
});

describe('applyJitter', () => {
  it('stays within [-20%, +20%] of base', () => {
    const base = 1000;
    for (let i = 0; i <= 10; i++) {
      const r = i / 10;
      const v = applyJitter(base, () => r);
      expect(v).toBeGreaterThanOrEqual(base * 0.8);
      expect(v).toBeLessThanOrEqual(base * 1.2);
    }
  });

  it('hits exact boundaries for deterministic random', () => {
    expect(applyJitter(1000, () => 0)).toBe(800); // -20%
    expect(applyJitter(1000, () => 1)).toBe(1200); // +20%
    expect(applyJitter(1000, () => 0.5)).toBe(1000); // 0%
  });
});

describe('parseRetryAfter', () => {
  const NOW = 1_700_000_000_000;

  it('returns 0 for null / empty / undefined', () => {
    expect(parseRetryAfter(null, () => NOW)).toBe(0);
    expect(parseRetryAfter(undefined, () => NOW)).toBe(0);
    expect(parseRetryAfter('', () => NOW)).toBe(0);
    expect(parseRetryAfter('   ', () => NOW)).toBe(0);
  });

  it('parses numeric seconds -> ms', () => {
    expect(parseRetryAfter('5', () => NOW)).toBe(5000);
    expect(parseRetryAfter('0', () => NOW)).toBe(0);
    expect(parseRetryAfter('  12 ', () => NOW)).toBe(12000);
  });

  it('parses HTTP-date in the future -> remaining ms', () => {
    const future = new Date(NOW + 5000).toUTCString();
    expect(parseRetryAfter(future, () => NOW)).toBe(5000);
  });

  it('clamps past HTTP-date to 0', () => {
    const past = new Date(NOW - 5000).toUTCString();
    expect(parseRetryAfter(past, () => NOW)).toBe(0);
  });

  it('returns 0 for garbage', () => {
    expect(parseRetryAfter('not-a-date', () => NOW)).toBe(0);
  });
});

describe('backoff', () => {
  const noJitter = () => 0.5; // jitter factor 0 -> pure base
  const maxJitter = () => 1; // +20%
  const minJitter = () => 0; // -20%

  it('429 with Retry-After takes the max of Retry-After and exponential (>= Retry-After)', () => {
    const headers = { get: (n: string) => (n.toLowerCase() === 'retry-after' ? '5' : null) };
    // exponential base at attempt 0 = 1000; even max-jittered = 1200 < 5000 -> 5000
    expect(backoff(0, 429, headers, { random: maxJitter })).toBe(5000);
    expect(backoff(0, 429, headers, { random: minJitter })).toBe(5000);
  });

  it('429 without Retry-After uses exponential+jitter', () => {
    expect(backoff(0, 429, undefined, { random: noJitter })).toBe(1000);
    expect(backoff(2, 429, undefined, { random: maxJitter })).toBe(4800); // 4000*1.2
  });

  it('429 with small Retry-After still respects exponential when larger', () => {
    const headers = { get: () => '1' }; // 1000ms
    expect(backoff(2, 429, headers, { random: maxJitter })).toBe(4800); // max(1000, 4800)
  });

  it('5xx / 408 / network(0) use exponential+jitter', () => {
    expect(backoff(0, 500, undefined, { random: noJitter })).toBe(1000);
    expect(backoff(1, 503, undefined, { random: noJitter })).toBe(2000);
    expect(backoff(0, 408, undefined, { random: noJitter })).toBe(1000);
    expect(backoff(0, 0, undefined, { random: noJitter })).toBe(1000);
  });

  it('4xx non-429 returns -1 (no retry)', () => {
    expect(backoff(0, 400, undefined)).toBe(-1);
    expect(backoff(0, 401, undefined)).toBe(-1);
    expect(backoff(0, 403, undefined)).toBe(-1);
    expect(backoff(0, 404, undefined)).toBe(-1);
    expect(backoff(0, 422, undefined)).toBe(-1);
  });
});

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const opts = (extra: Partial<RetryOptions> = {}): RetryOptions => ({
    backoffFn: () => 0, // no waiting
    sleep: async () => {},
    ...extra,
  });

  it('returns the result on first success and calls onSuccess', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const onSuccess = vi.fn();
    const res = await withRetry(fn, opts({ onSuccess }));
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx then succeeds (sleep called with backoff result)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi
      .fn<(a: number) => Promise<string>>()
      .mockRejectedValueOnce(httpErr(503))
      .mockResolvedValueOnce('ok');
    const onRetry = vi.fn();
    const res = await withRetry(fn, opts({ sleep, onRetry, backoffFn: () => 1234 }));
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1234);
    expect(onRetry).toHaveBeenCalledWith({ attempt: 0, status: 503, delayMs: 1234 });
  });

  it('does not retry 4xx non-429 (throws immediately, no sleep)', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockRejectedValue(httpErr(404));
    // Use the REAL backoff (returns -1 for 404); only inject sleep so we never actually wait.
    await expect(withRetry(fn, { sleep })).rejects.toThrow(/404/);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('exhausts maxRetries then throws the last error', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(503));
    await expect(withRetry(fn, opts({ maxRetries: 2 }))).rejects.toThrow(/503/);
    // initial attempt (0) + 2 retries (1, 2) = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('default maxRetries is 5 (6 total attempts)', async () => {
    const fn = vi.fn().mockRejectedValue(httpErr(500));
    await expect(withRetry(fn, opts())).rejects.toThrow(/500/);
    expect(fn).toHaveBeenCalledTimes(6);
  });

  it('calls onThrottle on 429', async () => {
    const onThrottle = vi.fn();
    const fn = vi
      .fn<(a: number) => Promise<string>>()
      .mockRejectedValueOnce(httpErr(429))
      .mockResolvedValueOnce('ok');
    await withRetry(fn, opts({ onThrottle }));
    expect(onThrottle).toHaveBeenCalledTimes(1);
  });

  it('does not call onThrottle on non-429 retryable', async () => {
    const onThrottle = vi.fn();
    const fn = vi
      .fn<(a: number) => Promise<string>>()
      .mockRejectedValueOnce(httpErr(503))
      .mockResolvedValueOnce('ok');
    await withRetry(fn, opts({ onThrottle }));
    expect(onThrottle).not.toHaveBeenCalled();
  });

  it('treats thrown value with no status as network error (status 0, retryable)', async () => {
    const fn = vi
      .fn<(a: number) => Promise<string>>()
      .mockRejectedValueOnce('plain string error')
      .mockResolvedValueOnce('ok');
    const res = await withRetry(fn, opts());
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses default backoff + default sleep (fake timers)', async () => {
    const fn = vi
      .fn<(a: number) => Promise<string>>()
      .mockRejectedValueOnce(httpErr(503))
      .mockResolvedValueOnce('ok');
    const p = withRetry(fn); // no injected backoff/sleep
    expect(fn).toHaveBeenCalledTimes(1);
    // default backoff(0,503) ~ 800-1200ms; advance past it
    await vi.advanceTimersByTimeAsync(2000);
    const res = await p;
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry once maxRetries reached even if retryable', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn().mockRejectedValue(httpErr(429, { 'retry-after': '1' }));
    await expect(withRetry(fn, opts({ maxRetries: 0 }))).rejects.toThrow(/429/);
    expect(fn).toHaveBeenCalledTimes(1); // maxRetries 0 => single attempt, no retries
    expect(onRetry).not.toHaveBeenCalled();
  });
});
