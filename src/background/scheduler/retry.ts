/**
 * 退避与重试（架构第 5.2 节）。
 *
 *  - backoff(attempt, status, headers)：计算下一次重试前应等待的毫秒数。
 *      · 429：尊重 Retry-After（数字秒 / HTTP-date），与指数退避取大。
 *      · 5xx / 408 / 网络错（status === 0）：指数退避 min(1000*2^n, 60000) + ±20% jitter。
 *      · 4xx（非 429）：不重试，返回 -1。
 *  - withRetry(fn, opts)：最多重试 maxRetries（默认 5）次的包装器。
 *
 * 纯函数部分（exponentialBase / applyJitter / parseRetryAfter）单独导出，便于确定性单测。
 *
 * 【SW 卸载边界】withRetry 默认用真实 setTimeout 等待退避。SW 被卸载会丢失该定时器；
 * 持久化重试恢复（storage.local + alarms）在 P0-10（TRA-11）处理。本任务内存版可用
 * setTimeout，sleep 可注入便于测试。
 */

/** Headers 访问接口（与 fetch Headers 兼容：get(name) => string | null）。 */
export interface BackoffHeaders {
  get(name: string): string | null;
}

/** 带状态码/响应头的错误（被重试的失败请求应抛出此形状）。 */
export interface RetryableError extends Error {
  status: number;
  headers?: BackoffHeaders;
}

/** backoff 的可注入选项（测试用：固定随机源 / 固定时钟）。 */
export interface BackoffOptions {
  /** 随机源，默认 Math.random，返回 [0,1)。用于 ±20% jitter。 */
  random?: () => number;
  /** 时钟（毫秒），默认 Date.now。用于解析 HTTP-date 形式的 Retry-After。 */
  now?: () => number;
}

/** 指数退避基数：min(1000 * 2^attempt, 60000) 毫秒。attempt 为 0 基（首次失败 = 0）。 */
export function exponentialBase(attempt: number): number {
  const raw = 1000 * 2 ** attempt;
  return Math.min(raw, 60000);
}

/** 应用 ±20% jitter：base * (1 + jitter)，jitter ∈ [-0.2, +0.2]。 */
export function applyJitter(base: number, random: () => number = Math.random): number {
  const jitter = (random() * 2 - 1) * 0.2; // [-0.2, +0.2]
  return Math.round(base * (1 + jitter));
}

/**
 * 解析 Retry-After 头为毫秒：
 *  - 数字字符串：秒 → *1000；
 *  - HTTP-date（RFC7231）：Date.parse 得到的时间戳减当前时间；
 *  - 空/非法：0。
 * 结果 clamp ≥ 0。
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: () => number = Date.now,
): number {
  if (value == null) return 0;
  const trimmed = value.trim();
  if (trimmed === '') return 0;
  // 数字秒
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, parsed - now());
}

/**
 * 计算下一次重试的等待毫秒数；返回 -1 表示该状态码不应重试（4xx 非 429）。
 *
 * @param attempt 已失败的尝试序号（0 基）
 * @param status HTTP 状态码；0 表示网络错误（连接失败/DNS/超时）
 * @param headers 响应头（取 Retry-After）
 */
export function backoff(
  attempt: number,
  status: number,
  headers?: BackoffHeaders,
  opts: BackoffOptions = {},
): number {
  const random = opts.random ?? Math.random;

  if (status === 429) {
    const raMs = parseRetryAfter(headers?.get('retry-after') ?? null, opts.now);
    return Math.max(raMs, applyJitter(exponentialBase(attempt), random));
  }

  if (status >= 500 || status === 408 || status === 0) {
    return applyJitter(exponentialBase(attempt), random);
  }

  // 4xx（非 429）：客户端错误，重试无意义。
  return -1;
}

/** withRetry 选项。 */
export interface RetryOptions {
  /** 最大重试次数（首次尝试之后的重试上限），默认 5。 */
  maxRetries?: number;
  /** 退避计算函数，默认本模块 backoff。注入便于测试。 */
  backoffFn?: typeof backoff;
  /** 睡眠函数，默认真实 setTimeout。注入便于测试。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次成功调用（用于把成功反馈给并发控制器 AIMD 恢复）。 */
  onSuccess?: () => void;
  /** 遇到 429 时调用（用于把降速反馈给并发控制器 AIMD）。 */
  onThrottle?: () => void;
  /** 每次决定重试前调用（观测/日志）。 */
  onRetry?: (info: { attempt: number; status: number; delayMs: number }) => void;
}

/** 从任意 thrown 值提取 status/headers。 */
function asRetryable(err: unknown): { status: number; headers?: BackoffHeaders } {
  if (err && typeof err === 'object') {
    const e = err as { status?: unknown; headers?: unknown };
    const status = typeof e.status === 'number' ? e.status : 0;
    const headers =
      e.headers && typeof (e.headers as BackoffHeaders).get === 'function'
        ? (e.headers as BackoffHeaders)
        : undefined;
    return { status, headers };
  }
  return { status: 0 };
}

/**
 * 包装一个异步函数，按退避策略重试。
 * fn 接收当前 attempt 序号（0 基），失败时应抛出带 status/headers 的错误。
 * 非重试错误（4xx 非 429）或重试耗尽时抛出最后一次错误。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 5;
  const backoffFn = opts.backoffFn ?? backoff;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await fn(attempt);
      opts.onSuccess?.();
      return result;
    } catch (err) {
      const { status, headers } = asRetryable(err);
      if (attempt >= maxRetries) throw err;

      const delayMs = backoffFn(attempt, status, headers);
      if (delayMs < 0) throw err; // 非重试错误

      if (status === 429) opts.onThrottle?.();
      opts.onRetry?.({ attempt, status, delayMs });

      await sleep(delayMs);
      attempt++;
    }
  }
}
