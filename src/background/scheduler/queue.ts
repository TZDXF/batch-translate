/**
 * 内存任务队列（架构第 3 节 scheduler/queue.ts）。
 *
 * 职责：缓存待调度任务，drain() 时全部经 ConcurrencyController 调度执行（由控制器
 * 保证全局在途 ≤ maxConcurrent + 令牌桶限速）。
 *
 * 【持久化边界】本版纯内存。MV3 Service Worker 被卸载会丢失队列与在途任务；
 * 持久化队列（storage.local 批次状态 + chrome.alarms 恢复）在 P0-10（TRA-11）实现。
 * 本任务只做内存队列 + 调度逻辑。
 */

import { ConcurrencyController } from './concurrency-controller';

/** 队列中的一个任务。 */
export interface QueueTask<T = unknown> {
  /** 稳定 id（用于日志/未来持久化 key）。 */
  id: string;
  /** 实际执行函数（通常是「发一次翻译请求」）。 */
  run: () => Promise<T>;
  /**
   * 调度成本：传给 controller.acquire(cost)（TPM 计费用 token 量）；RPS 桶恒按 1 计。
   * 默认 1。
   */
  cost?: number;
  /** 优先级，数值越大越先被派发（drain 前按其降序排列）。默认 0。 */
  priority?: number;
}

/** drain 完成后的单个任务结果。 */
export interface QueueResult<T = unknown> {
  id: string;
  ok: boolean;
  value?: T;
  error?: unknown;
}

/** drain 选项。 */
export interface DrainOptions {
  /** 任务完成回调（成功/失败均触发）。 */
  onResult?: (result: QueueResult) => void;
}

export class TaskQueue<T = unknown> {
  private readonly tasks: QueueTask<T>[] = [];
  private draining = false;

  /** 当前队列中未派发的任务数。 */
  get size(): number {
    return this.tasks.length;
  }

  /** 是否正在 drain。 */
  get isDraining(): boolean {
    return this.draining;
  }

  /** 入队单个任务。 */
  enqueue(task: QueueTask<T>): void {
    this.tasks.push(task);
  }

  /** 批量入队。 */
  enqueueAll(tasks: readonly QueueTask<T>[]): void {
    for (const t of tasks) this.tasks.push(t);
  }

  /** 清空队列（不影响在途任务）。 */
  clear(): void {
    this.tasks.length = 0;
  }

  /**
   * 取出全部任务，按优先级降序（同优先级保持入队顺序）后，全部经 controller 调度执行，
   * 等待所有完成。并发上限由 controller 保证。
   *
   * 返回每个任务的结果（成功/失败）；单个任务抛错不会中断其他任务。
   */
  async drain(
    controller: ConcurrencyController,
    opts: DrainOptions = {},
  ): Promise<QueueResult<T>[]> {
    if (this.draining) {
      throw new Error('TaskQueue.drain: already draining');
    }
    this.draining = true;
    // 快照并清空内部队列；按优先级降序派发（稳定排序保持入队顺序）。
    const snapshot = this.tasks.splice(0).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    try {
      const results = await Promise.all(
        snapshot.map((task) => this.runOne(controller, task, opts)),
      );
      return results;
    } finally {
      this.draining = false;
    }
  }

  private async runOne(
    controller: ConcurrencyController,
    task: QueueTask<T>,
    opts: DrainOptions,
  ): Promise<QueueResult<T>> {
    const cost = task.cost ?? 1;
    await controller.acquire(cost);
    try {
      const value = await task.run();
      const result: QueueResult<T> = { id: task.id, ok: true, value };
      opts.onResult?.(result);
      return result;
    } catch (error) {
      const result: QueueResult<T> = { id: task.id, ok: false, error };
      opts.onResult?.(result);
      return result;
    } finally {
      controller.release();
    }
  }
}
