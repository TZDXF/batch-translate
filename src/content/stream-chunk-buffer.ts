/**
 * 流式 chunk 节流缓冲（P1-2 / TRA-17，架构 2.2 STREAM_CHUNK）。
 *
 * STREAM_CHUNK 高频到达（逐 token / 逐字符），若每次都触发 renderer.appendChunk 的
 * replaceChildren，会在主线程产生大量重排。本缓冲把同 tick 内多个 chunk 按 id 合并，
 * 由定时器统一 flush，每个 id 每次 tick 只回调一次 onFlush(id, 累计 delta)。
 *
 * 纯逻辑（无 DOM 依赖）：onFlush 由调用方（controller）注入，把 delta 交给 renderer。
 * 测试可直接驱动 push / flush，无需 jsdom 定时器魔法。
 *
 * 幂等（架构 9）：缓冲无外部副作用；流式结束 RESULT 由 controller 清空该 id 的 pending
 * 并 setText 整段覆盖，flush 不会在 setText 后追加陈旧 delta。
 */
export interface StreamChunkSink {
  /** flush 时按 id 回调累计 delta（自上次 flush 以来该 id 的新增片段）。 */
  onFlush(id: string, delta: string): void;
}

export class StreamChunkThrottle {
  private readonly pending = new Map<string, string>();
  private flushScheduled = false;
  private readonly timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: StreamChunkSink,
    private readonly flushMs: number = 30,
    private readonly scheduler: (fn: () => void, ms: number) => ReturnType<typeof setTimeout> = setTimeout,
  ) {}

  /** 喂入一个 chunk：累加到该 id 的 pending，并安排一次 flush（若未安排）。 */
  push(id: string, chunk: string): void {
    if (!id || !chunk) return;
    this.pending.set(id, (this.pending.get(id) ?? '') + chunk);
    this.scheduleFlush();
  }

  /** 主动 flush：把所有 pending delta 交给 sink，清空缓冲。 */
  flush(): void {
    this.flushScheduled = false;
    if (this.pending.size === 0) return;
    const entries = [...this.pending];
    this.pending.clear();
    for (const [id, delta] of entries) this.sink.onFlush(id, delta);
  }

  /** 清空某 id 的 pending（RESULT 到达时调用，避免 setText 后追加陈旧 delta）。 */
  discard(id: string): void {
    this.pending.delete(id);
  }

  /** 清空全部 pending（关闭翻译 / teardown 时调用）。 */
  clear(): void {
    this.pending.clear();
    this.flushScheduled = false;
  }

  /** 是否有待 flush 的 chunk（测试/诊断用）。 */
  hasPending(): boolean {
    return this.pending.size > 0;
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.scheduler(() => this.flush(), this.flushMs);
  }
}
