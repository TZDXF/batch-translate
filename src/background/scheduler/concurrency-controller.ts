/**
 * 并发控制器：有界并发（并发槽）+ 令牌桶（RPS / TPM）+ AIMD 降速恢复。
 * 架构第 5.1 / 5.2 节。
 *
 * 职责：
 *  - gate：限制全局在途请求数 ≤ maxConcurrent（全局唯一 Service Worker 内集中限流，
 *    避免沉浸式那种页面侧 N×N 并发爆炸）。
 *  - tokenBucket：按时间补桶的令牌桶，强制 RPS（默认 2 req/s，防 429）；可选 TPM
 *    （token/min，按批 token 量计 cost）。
 *  - AIMD：429 后 recordThrottle() 将当前 RPS 减半（multiplicative decrease）；
 *    连续成功 N 次 recordSuccess() 恢复到目标 RPS（架构 5.2）。
 *
 * 时钟/定时器可注入（now），便于 Vitest 用 fake timers 确定性测试。
 *
 * 【SW 卸载边界】本内存版令牌桶等待用 setTimeout（架构 5 节约束：退避/限流等待
 * 不靠 setTimeout 保活 SW）。SW 被卸载会丢失内存态与在途 setTimeout；持久化队列 +
 * chrome.alarms 恢复在 P0-10（TRA-11）处理。本任务只做内存版调度逻辑。
 */

import { DEFAULT_AIMD } from './config';
import type { AimdConfig } from './config';

/** acquire / release 的构造选项。 */
export interface ConcurrencyControllerOptions {
  /** 全局最大并发，默认 3（架构 5.3）。 */
  maxConcurrent?: number;
  /** 目标 RPS（req/s），默认 2。 */
  rps?: number;
  /**
   * TPM（token/min），0 = 关闭。开启后另起一个 token 桶，acquire(cost) 的 cost 视为
   * 该批 token 量；RPS 桶 cost 始终按 1 计（每请求 1 个 RPS 令牌）。
   */
  tpmLimit?: number;
  /** AIMD 参数（恢复阈值 / 降速下限）。 */
  aimd?: Partial<AimdConfig>;
  /** 可注入时钟（毫秒），默认 Date.now。测试用。 */
  now?: () => number;
}

interface Bucket {
  /** 当前可用令牌。 */
  available: number;
  /** 桶容量（突发上限）。 */
  capacity: number;
  /** 补桶速率（令牌/毫秒）。 */
  ratePerMs: number;
  /** 上次补桶时间戳（毫秒）。 */
  lastRefill: number;
}

export class ConcurrencyController {
  /** 当前在途（已占槽、未 release）的请求数。 */
  private active = 0;
  /** 等待并发槽的 resolver 队列（FIFO）。 */
  private readonly gateWaiters: Array<() => void> = [];

  /** RPS 令牌桶。 */
  private readonly rpsBucket: Bucket;
  /** TPM 令牌桶（tpmLimit>0 时启用）。 */
  private readonly tpmBucket: Bucket | null;

  /** 目标 RPS（AIMD 恢复目标）。 */
  private readonly targetRps: number;
  /** 当前生效 RPS（AIMD 可临时下调）。 */
  private currentRps: number;
  private readonly maxConcurrent: number;
  private readonly minRps: number;
  private readonly recoveryThreshold: number;

  /** 连续成功计数（用于 AIMD 恢复）。 */
  private successStreak = 0;

  private readonly now: () => number;

  constructor(opts: ConcurrencyControllerOptions = {}) {
    const maxConcurrent = opts.maxConcurrent ?? 3;
    if (maxConcurrent < 1) throw new RangeError('maxConcurrent must be >= 1');
    const rps = opts.rps ?? 2;
    if (rps <= 0) throw new RangeError('rps must be > 0');

    const aimd: AimdConfig = { ...DEFAULT_AIMD, ...opts.aimd };
    this.maxConcurrent = maxConcurrent;
    this.targetRps = rps;
    this.currentRps = rps;
    this.minRps = aimd.minRps;
    this.recoveryThreshold = aimd.recoveryThreshold;
    this.now = opts.now ?? (() => Date.now());

    this.rpsBucket = this.makeBucket(rps / 1000, rps);

    const tpmLimit = opts.tpmLimit ?? 0;
    // TPM 单位是 token/min，故补桶速率按 /60000 折算到毫秒（与 RPS 的 /1000 区分）。
    this.tpmBucket =
      tpmLimit > 0 ? this.makeBucket(tpmLimit / 60000, tpmLimit) : null;
  }

  /** 当前在途请求数。 */
  get inFlight(): number {
    return this.active;
  }

  /** 当前生效 RPS（AIMD 调整后）。 */
  get effectiveRps(): number {
    return this.currentRps;
  }

  /** RPS 桶当前可用令牌数（测试/可观测用）。 */
  get availableRpsTokens(): number {
    return this.rpsBucket.available;
  }

  /**
   * 申请一个调度槽：先过并发闸门（gate），再过令牌桶（RPS + 可选 TPM）。
   * `cost` 为 TPM 计费用 token 量（默认 1）；RPS 桶恒按 1 令牌/请求消耗。
   */
  async acquire(cost = 1): Promise<void> {
    await this.gate();
    await this.consume(this.rpsBucket, 1);
    if (this.tpmBucket) await this.consume(this.tpmBucket, cost);
  }

  /** 释放调度槽。rate 预算由请求真实消耗、按时间补桶，不在 release 时退回（见上）。 */
  release(): void {
    const next = this.gateWaiters.shift();
    if (next) {
      // 将槽直接移交给队首等待者，active 不变（出一进一）。
      next();
    } else {
      this.active--;
    }
  }

  /** 请求成功反馈：连续成功达阈值则把 RPS 恢复到目标值（AIMD 恢复）。 */
  recordSuccess(): void {
    this.successStreak++;
    if (this.currentRps < this.targetRps && this.successStreak >= this.recoveryThreshold) {
      this.setRps(this.targetRps);
      this.successStreak = 0;
    }
  }

  /** 429 反馈：RPS 减半（multiplicative decrease），重置成功计数。 */
  recordThrottle(): void {
    this.setRps(Math.max(this.currentRps / 2, this.minRps));
    this.successStreak = 0;
  }

  /** 并发闸门：在途达上限则排队等待，否则占槽（active++）。 */
  private async gate(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.gateWaiters.push(resolve);
    });
    // resolve 由 release() 触发——此时槽已被移交（active 已计入），无需再 active++。
  }

  /**
   * 从令牌桶消耗 cost：先按时间补桶；足够则消耗，不足则等待补够再消耗。
   * 单次需求超过桶容量（如超大批 token）时，桶补满即放行并清空，避免死循环。
   */
  private async consume(bucket: Bucket, cost: number): Promise<void> {
    if (cost <= 0) return;
    while (true) {
      this.refill(bucket);
      if (bucket.available >= cost) {
        bucket.available -= cost;
        return;
      }
      if (bucket.available >= bucket.capacity) {
        // 桶已满但单次需求 > 容量：放行该请求并清空桶（一次性大请求）。
        bucket.available = 0;
        return;
      }
      const deficit = cost - bucket.available;
      const waitMs = deficit / bucket.ratePerMs;
      await this.sleep(waitMs);
    }
  }

  /** 按经过时间补桶，封顶 capacity。 */
  private refill(bucket: Bucket): void {
    const now = this.now();
    const elapsed = now - bucket.lastRefill;
    if (elapsed > 0) {
      bucket.available = Math.min(
        bucket.capacity,
        bucket.available + elapsed * bucket.ratePerMs,
      );
      bucket.lastRefill = now;
    }
  }

  /** 设置当前 RPS 并同步刷新 RPS 桶的速率/容量，令牌 clamp 到新容量。 */
  private setRps(rps: number): void {
    this.currentRps = rps;
    this.refill(this.rpsBucket);
    this.rpsBucket.ratePerMs = rps / 1000;
    this.rpsBucket.capacity = Math.max(1, rps);
    this.rpsBucket.available = Math.min(this.rpsBucket.available, this.rpsBucket.capacity);
  }

  /** 构造令牌桶：ratePerMs 为补桶速率（令牌/毫秒），capacity 为突发上限。 */
  private makeBucket(ratePerMs: number, capacity: number): Bucket {
    return {
      available: capacity,
      capacity,
      ratePerMs,
      lastRefill: this.now(),
    };
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
