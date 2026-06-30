import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  LayoutGuard,
  resolveInsertionPoint,
  insertWrapper,
  isAtTarget,
} from './layout-guard';
import { render } from './bilingual-renderer';

/** 等待 MutationObserver 微任务回调落地（jsdom 异步派发）。 */
function flushMicrotasks(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('layout-guard —— 容器感知插入点解析', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('普通 block 段落：after 模式，anchor 为该节点', () => {
    const p = document.createElement('p');
    document.body.appendChild(p);
    const target = resolveInsertionPoint(p);
    expect(target.mode).toBe('after');
    expect(target.anchor).toBe(p);
  });

  it('flex 直接 item：inside 模式，anchor 为该 item', () => {
    const flex = document.createElement('div');
    flex.style.display = 'flex';
    const item = document.createElement('div');
    flex.appendChild(item);
    document.body.appendChild(flex);

    const target = resolveInsertionPoint(item);
    expect(target.mode).toBe('inside');
    expect(target.anchor).toBe(item);
  });

  it('grid 直接 item：inside 模式', () => {
    const grid = document.createElement('div');
    grid.style.display = 'grid';
    const item = document.createElement('div');
    grid.appendChild(item);
    document.body.appendChild(grid);

    expect(resolveInsertionPoint(item).mode).toBe('inside');
  });

  it('表格行级节点：下钻到首个 cell', () => {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    tr.appendChild(td);
    document.body.appendChild(tr);

    const target = resolveInsertionPoint(tr);
    // cell 内无块级子 → anchor 为 cell，after 模式（wrapper 进 cell）
    expect(target.mode).toBe('after');
    expect(target.anchor).toBe(td);
  });
});

describe('layout-guard —— insertWrapper / isAtTarget', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('after 模式插到 anchor 之后', () => {
    const a = document.createElement('div');
    const parent = document.createElement('div');
    parent.appendChild(a);
    document.body.appendChild(parent);

    const wrapper = document.createElement('div');
    insertWrapper({ mode: 'after', anchor: a }, wrapper);
    expect(a.nextElementSibling).toBe(wrapper);
    expect(isAtTarget({ mode: 'after', anchor: a }, wrapper)).toBe(true);
  });

  it('inside 模式追加为 anchor 子节点', () => {
    const anchor = document.createElement('div');
    document.body.appendChild(anchor);
    const wrapper = document.createElement('div');
    insertWrapper({ mode: 'inside', anchor }, wrapper);
    expect(anchor.lastElementChild).toBe(wrapper);
    expect(isAtTarget({ mode: 'inside', anchor }, wrapper)).toBe(true);
  });

  it('wrapper 被移除后 isAtTarget 为 false', () => {
    const a = document.createElement('div');
    document.body.appendChild(a);
    const wrapper = document.createElement('div');
    insertWrapper({ mode: 'after', anchor: a }, wrapper);
    expect(isAtTarget({ mode: 'after', anchor: a }, wrapper)).toBe(true);

    wrapper.remove();
    expect(isAtTarget({ mode: 'after', anchor: a }, wrapper)).toBe(false);
  });
});

describe('layout-guard —— 重排重插（核心）', () => {
  let guard: LayoutGuard;

  beforeEach(() => {
    document.body.innerHTML = '';
    guard = new LayoutGuard();
  });

  afterEach(() => {
    guard.dispose();
  });

  it('页面 JS 删除译文 wrapper → guard 自动重新插入原位', async () => {
    const p = document.createElement('p');
    p.textContent = 'original';
    document.body.appendChild(p);

    const handle = render({ id: 'r1', node: p, text: 'original' }, '译文');
    guard.watch('r1', p, handle.wrapper, handle.target);

    expect(p.nextElementSibling).toBe(handle.wrapper);

    // 模拟页面 JS（如 React 重渲染）删除译文节点
    handle.wrapper.remove();
    expect(handle.wrapper.parentElement).toBeNull();

    // 等待 MutationObserver 回调
    await vi.waitFor(
      () => {
        expect(handle.wrapper.parentElement).not.toBeNull();
      },
      { timeout: 1000, interval: 10 },
    );

    // 重插后回到原位：仍是 p 的下一个兄弟
    expect(p.nextElementSibling).toBe(handle.wrapper);
    expect(isAtTarget(handle.target, handle.wrapper)).toBe(true);
  });

  it('guard 重插后不会无限递归（收敛于一次重插）', async () => {
    const p = document.createElement('p');
    document.body.appendChild(p);
    const handle = render({ id: 'r2', node: p, text: 'x' }, 'y');
    guard.watch('r2', p, handle.wrapper, handle.target);

    handle.wrapper.remove();
    await vi.waitFor(() => expect(handle.wrapper.parentElement).not.toBeNull(), {
      timeout: 1000,
    });

    // 再等若干 tick，确认 wrapper 仍稳定在位（未被反复增删）
    await flushMicrotasks(30);
    expect(p.nextElementSibling).toBe(handle.wrapper);
  });

  it('unwatch 后不再守护：删除 wrapper 不会重插', async () => {
    const p = document.createElement('p');
    document.body.appendChild(p);
    const handle = render({ id: 'r3', node: p, text: 'x' }, 'y');
    guard.watch('r3', p, handle.wrapper, handle.target);

    guard.unwatch('r3');
    handle.wrapper.remove();
    await flushMicrotasks(30);

    expect(handle.wrapper.parentElement).toBeNull();
  });

  it('dispose 后全部停止守护', async () => {
    const p = document.createElement('p');
    document.body.appendChild(p);
    const handle = render({ id: 'r4', node: p, text: 'x' }, 'y');
    guard.watch('r4', p, handle.wrapper, handle.target);

    guard.dispose();
    handle.wrapper.remove();
    await flushMicrotasks(30);

    expect(handle.wrapper.parentElement).toBeNull();
  });

  it('recheckAll 主动校验并补插脱离原位的 wrapper', async () => {
    const p = document.createElement('p');
    document.body.appendChild(p);
    const handle = render({ id: 'r5', node: p, text: 'x' }, 'y');
    guard.watch('r5', p, handle.wrapper, handle.target);

    // 不经过 observer 直接移除并立刻同步校验
    handle.wrapper.remove();
    expect(handle.wrapper.parentElement).toBeNull();

    guard.recheckAll();
    expect(handle.wrapper.parentElement).not.toBeNull();
    expect(p.nextElementSibling).toBe(handle.wrapper);
  });
});
