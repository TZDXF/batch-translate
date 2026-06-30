/**
 * 双语渲染器交互增强测试（P1-3）：悬停操作条 + 编辑态 + getText/setText。
 * 验证不破坏现有渲染排版保护契约（wrapper 位置 / 原节点零污染）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, type RenderActions } from './bilingual-renderer';
import type { Paragraph } from '../../shared/types';

function makeParagraph(id: string, text = 'Hello world.'): Paragraph {
  const node = document.createElement('p');
  node.textContent = text;
  document.body.appendChild(node);
  return { id, node, text };
}

function makeActions(): RenderActions & { calls: { retranslate: number; edit: string[]; copy: number } } {
  const calls = { retranslate: 0, edit: [] as string[], copy: 0 };
  return {
    retranslate: () => { calls.retranslate++; },
    edit: (t: string) => { calls.edit.push(t); },
    copy: () => { calls.copy++; },
    calls,
  };
}

describe('渲染器交互增强（P1-3）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('提供 actions 时渲染 重译/编辑/复制 操作条', () => {
    const p = makeParagraph('p1');
    const actions = makeActions();
    const handle = render(p, '你好', { actions });
    const toolbar = handle.wrapper.querySelector('.bt-translation__toolbar');
    expect(toolbar).not.toBeNull();
    const labels = Array.from(toolbar!.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['重译', '编辑', '复制']);
  });

  it('无 actions 时不渲染操作条（P0 行为不变）', () => {
    const p = makeParagraph('p1');
    const handle = render(p, '你好');
    expect(handle.wrapper.querySelector('.bt-translation__toolbar')).toBeNull();
  });

  it('点击 重译 / 复制 触发回调', () => {
    const p = makeParagraph('p1');
    const actions = makeActions();
    const handle = render(p, '你好', { actions });
    const btns = handle.wrapper.querySelectorAll<HTMLButtonElement>('.bt-translation__toolbar button');
    btns[0]!.click(); // 重译
    btns[2]!.click(); // 复制
    expect(actions.calls.retranslate).toBe(1);
    expect(actions.calls.copy).toBe(1);
  });

  it('编辑 → 保存：回写回调带回新文本并更新显示', () => {
    const p = makeParagraph('p1');
    const actions = makeActions();
    const handle = render(p, '你好', { actions });
    // 进入编辑态。
    handle.enterEdit();
    const textarea = handle.wrapper.querySelector<HTMLTextAreaElement>('.bt-translation__edit textarea');
    expect(textarea).not.toBeNull();
    textarea!.value = '你好，世界';
    // 点击保存。
    const save = handle.wrapper.querySelector<HTMLButtonElement>('.bt-translation__edit__actions button');
    save!.click();
    expect(actions.calls.edit).toEqual(['你好，世界']);
    // 保存后退出编辑态（编辑容器移除）。
    expect(handle.wrapper.querySelector('.bt-translation__edit')).toBeNull();
  });

  it('编辑 → 取消：不触发回写，恢复显示', () => {
    const p = makeParagraph('p1');
    const actions = makeActions();
    const handle = render(p, '你好', { actions });
    handle.enterEdit();
    const cancel = handle.wrapper.querySelectorAll<HTMLButtonElement>('.bt-translation__edit__actions button')[1]!;
    cancel.click();
    expect(actions.calls.edit).toEqual([]);
    expect(handle.wrapper.querySelector('.bt-translation__edit')).toBeNull();
  });

  it('getText 返回当前译文；setText 刷新文本容器而非清掉操作条', () => {
    const p = makeParagraph('p1');
    const actions = makeActions();
    const handle = render(p, '你好', { actions });
    expect(handle.getText()).toBe('你好');
    handle.setText('新译文');
    expect(handle.getText()).toBe('新译文');
    // 操作条仍在。
    expect(handle.wrapper.querySelector('.bt-translation__toolbar')).not.toBeNull();
    // 文本容器显示新译文。
    expect(handle.wrapper.querySelector('.bt-translation__text')?.textContent).toContain('新译文');
  });

  it('不破坏排版保护：wrapper 仍紧随原节点，原节点属性零污染', () => {
    const p = document.createElement('p');
    p.id = 'orig';
    p.className = 'lead';
    p.textContent = 'Hello world.';
    document.body.appendChild(p);
    const before = Array.from(p.attributes).map((a) => a.name).join(',');
    const handle = render({ id: 'p1', node: p, text: 'Hello world.' }, '你好', { actions: makeActions() });
    expect(p.previousElementSibling).toBeNull();
    expect(p.nextElementSibling).toBe(handle.wrapper);
    expect(Array.from(p.attributes).map((a) => a.name).join(',')).toBe(before);
    expect(p.className).toBe('lead');
  });
});
