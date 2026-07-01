/**
 * hover-overlay 测试（P2-4 / TRA-27）：浮层生命周期与定位。
 * 覆盖：挂载 / setText / markError / markLoading / reposition / 编辑态 / 移除。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mountHoverOverlay } from './hover-overlay';
import type { Paragraph } from '../../shared/types';

function makeParagraph(id: string): Paragraph {
  const node = document.createElement('p');
  node.textContent = 'Hello world.';
  document.body.appendChild(node);
  return { id, node, text: 'Hello world.' };
}

describe('hover-overlay —— 生命周期', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('挂载：浮层为 body 子节点，bt-hover 前缀隔离', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    expect(h.overlay.className).toBe('bt-hover');
    expect(h.overlay.dataset.btId).toBe('p1');
    expect(h.overlay.getAttribute('data-bt-hover')).toBe('');
    expect(document.body.contains(h.overlay)).toBe(true);
    h.remove();
  });

  it('markLoading → setText：loading 占位被译文覆盖', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    h.markLoading();
    expect(h.overlay.textContent).toContain('翻译中');
    h.setText('机器翻译。');
    expect(h.overlay.textContent).toContain('机器翻译。');
    expect(h.overlay.textContent).not.toContain('翻译中');
    expect(h.getText()).toBe('机器翻译。');
    h.remove();
  });

  it('markError / clearError', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    h.setText('译');
    h.markError('超时');
    expect(h.overlay.className).toContain('bt-hover__error');
    expect(h.overlay.textContent).toContain('翻译失败：超时');
    h.clearError();
    expect(h.overlay.className).not.toContain('bt-hover__error');
    expect(h.overlay.textContent).toContain('译');
    h.remove();
  });

  it('reposition：浮层定位为 fixed 且不抛错', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    expect(() => h.reposition()).not.toThrow();
    // position: fixed 由样式表设定；reposition 写入 left/top 内联像素值。
    expect(h.overlay.style.left).toMatch(/^-?\d+px$/);
    expect(h.overlay.style.top).toMatch(/^-?\d+px$/);
    h.remove();
  });

  it('setDisplayMode：original 隐藏浮层', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    h.setDisplayMode('original');
    expect(h.overlay.style.display).toBe('none');
    h.setDisplayMode('bilingual');
    expect(h.overlay.style.display).not.toBe('none');
    h.remove();
  });

  it('操作条：提供 actions 时渲染 重译/编辑/复制 三按钮', () => {
    const p = makeParagraph('p1');
    let edited = '';
    const h = mountHoverOverlay(p, {
      actions: {
        retranslate: () => {},
        edit: (t: string) => { edited = t; },
        copy: () => {},
      },
    });
    const btns = h.overlay.querySelectorAll('.bt-hover__btn');
    expect(btns.length).toBe(3);
    // 编辑按钮 data-bt-action="edit"。
    const editBtn = h.overlay.querySelector<HTMLButtonElement>('[data-bt-action="edit"]');
    expect(editBtn).not.toBeNull();
    h.setText('旧译文');
    editBtn!.click();
    const textarea = h.overlay.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    textarea.value = '新译文';
    // 点击编辑态的「保存」按钮（.bt-hover__edit-actions 内首个按钮）。
    const saveBtn = h.overlay.querySelector<HTMLButtonElement>('.bt-hover__edit-actions .bt-hover__btn')!;
    saveBtn.click();
    // 编辑态退出。
    expect(h.overlay.querySelector('textarea')).toBeNull();
    expect(edited).toBe('新译文');
    h.remove();
  });

  it('remove：浮层从 DOM 移除', () => {
    const p = makeParagraph('p1');
    const h = mountHoverOverlay(p);
    expect(document.body.contains(h.overlay)).toBe(true);
    h.remove();
    expect(document.body.contains(h.overlay)).toBe(false);
  });
});
