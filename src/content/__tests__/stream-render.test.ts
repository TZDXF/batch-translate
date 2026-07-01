/**
 * 流式 chunk 增量渲染测试（P1-2 / TRA-17 验收：chunk 增量渲染）。
 *
 * 覆盖：
 *  - StreamChunkThrottle：同 tick 多 chunk 合并 flush、per-id 累计、discard/clear、定时 flush。
 *  - 端到端 chunk 增量渲染：STREAM_CHUNK 经 throttle → renderer.appendChunk，wrapper 文本逐增；
 *    RESULT 到达后 setText 整段覆盖，pending 被 discard 不追加陈旧 delta。
 *
 * jsdom 环境（renderer 注入真实 DOM wrapper）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '../renderer/bilingual-renderer';
import { StreamChunkThrottle } from '../stream-chunk-buffer';
import type { Paragraph } from '../../shared/types';

function makeParagraph(id: string): Paragraph {
  const node = document.createElement('p');
  node.textContent = 'Hello.';
  document.body.appendChild(node);
  return { id, node, text: 'Hello.' };
}

describe('StreamChunkThrottle — 节流缓冲', () => {
  it('同 tick 多 chunk 合并：push 多次只触发一次 onFlush，delta 累计', () => {
    const flushed: { id: string; delta: string }[] = [];
    const throttle = new StreamChunkThrottle(
      { onFlush: (id, delta) => flushed.push({ id, delta }) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>, // 不实际定时；手动 flush
    );
    throttle.push('1', '你');
    throttle.push('1', '好');
    throttle.push('2', '世');
    // 未 flush 前 onFlush 不触发。
    expect(flushed).toHaveLength(0);
    expect(throttle.hasPending()).toBe(true);

    throttle.flush();
    expect(flushed).toEqual([{ id: '1', delta: '你好' }, { id: '2', delta: '世' }]);
    expect(throttle.hasPending()).toBe(false);
  });

  it('flush 后再次 push 重新累积', () => {
    const flushed: string[] = [];
    const throttle = new StreamChunkThrottle(
      { onFlush: (_id, delta) => flushed.push(delta) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    throttle.push('1', 'ab');
    throttle.flush();
    throttle.push('1', 'cd');
    throttle.flush();
    expect(flushed).toEqual(['ab', 'cd']);
  });

  it('discard：清掉某 id pending，flush 不再回调它', () => {
    const flushed: { id: string; delta: string }[] = [];
    const throttle = new StreamChunkThrottle(
      { onFlush: (id, delta) => flushed.push({ id, delta }) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    throttle.push('1', 'x');
    throttle.push('2', 'y');
    throttle.discard('1');
    throttle.flush();
    expect(flushed).toEqual([{ id: '2', delta: 'y' }]);
  });

  it('clear：清空全部 pending', () => {
    const flushed: string[] = [];
    const throttle = new StreamChunkThrottle(
      { onFlush: (_id, delta) => flushed.push(delta) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    throttle.push('1', 'x');
    throttle.clear();
    throttle.flush();
    expect(flushed).toHaveLength(0);
  });

  it('定时 flush：scheduler 到期后自动 flush', () => {
    const flushed: string[] = [];
    let scheduled: (() => void) | null = null;
    const throttle = new StreamChunkThrottle(
      { onFlush: (_id, delta) => flushed.push(delta) },
      30,
      (fn) => {
        scheduled = fn;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );
    throttle.push('1', 'hi');
    expect(scheduled).not.toBeNull();
    scheduled!();
    expect(flushed).toEqual(['hi']);
  });
});

describe('chunk 增量渲染（throttle → renderer.appendChunk 端到端）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('STREAM_CHUNK 经 throttle flush 后 wrapper 文本逐增', () => {
    const p = makeParagraph('p1');
    const handle = render(p, '');

    const throttle = new StreamChunkThrottle(
      { onFlush: (id, delta) => handle.appendChunk(delta) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    expect(handle.wrapper.textContent).toBe('');

    throttle.push('p1', '你');
    throttle.push('p1', '好');
    // flush 前 wrapper 未变。
    expect(handle.wrapper.textContent).toBe('');
    throttle.flush();
    expect(handle.wrapper.textContent).toBe('你好');

    throttle.push('p1', '，世界');
    throttle.flush();
    expect(handle.wrapper.textContent).toBe('你好，世界');
  });

  it('RESULT setText 整段覆盖：discard 后 flush 不追加陈旧 delta', () => {
    const p = makeParagraph('p1');
    const handle = render(p, '');

    const throttle = new StreamChunkThrottle(
      { onFlush: (id, delta) => handle.appendChunk(delta) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    throttle.push('p1', '部分');
    // 模拟流式结束：RESULT 到达 → discard + setText 整段。
    throttle.discard('p1');
    handle.setText('完整的最终译文');
    // 即使此后 flush 触发，pending 已空，不会追加。
    throttle.flush();
    expect(handle.wrapper.textContent).toBe('完整的最终译文');
    expect(handle.getText()).toBe('完整的最终译文');
  });

  it('多 id 并发流式：各自 wrapper 独立累加', () => {
    const p1 = makeParagraph('p1');
    const p2 = makeParagraph('p2');
    const h1 = render(p1, '');
    const h2 = render(p2, '');
    const handles = new Map([['p1', h1], ['p2', h2]]);

    const throttle = new StreamChunkThrottle(
      { onFlush: (id, delta) => handles.get(id)?.appendChunk(delta) },
      30,
      () => 0 as unknown as ReturnType<typeof setTimeout>,
    );
    throttle.push('p1', '甲');
    throttle.push('p2', '乙');
    throttle.push('p1', '丙');
    throttle.push('p2', '丁');
    throttle.flush();

    expect(h1.wrapper.textContent).toBe('甲丙');
    expect(h2.wrapper.textContent).toBe('乙丁');
  });
});

// 触避未用 import 警告（vi 用于未来定时器相关断言）。
void vi;
