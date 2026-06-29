import { describe, it, expect, beforeEach } from 'vitest';
import { ParagraphRegistry } from './paragraph-registry';
import type { Paragraph } from '../shared/types';

function makeParagraph(id: string, text = 'hello'): Paragraph {
  const node = document.createElement('p');
  node.textContent = text;
  return { id, node, text };
}

describe('ParagraphRegistry', () => {
  let registry: ParagraphRegistry;

  beforeEach(() => {
    document.body.innerHTML = '';
    registry = new ParagraphRegistry();
  });

  it('register / get / has', () => {
    const p = makeParagraph('p1', 'Hello');
    registry.register(p);

    expect(registry.has('p1')).toBe(true);
    expect(registry.has('missing')).toBe(false);

    const entry = registry.get('p1');
    expect(entry).toBeDefined();
    expect(entry?.id).toBe('p1');
    expect(entry?.node).toBe(p.node);
    expect(entry?.sourceText).toBe('Hello');
    expect(entry?.status).toBe('pending');
    expect(entry?.wrapper).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  it('registerMany 批量登记', () => {
    registry.registerMany([makeParagraph('a'), makeParagraph('b'), makeParagraph('c')]);
    expect(registry.size).toBe(3);
    expect(registry.has('b')).toBe(true);
  });

  it('setWrapper 记录译文节点引用', () => {
    registry.register(makeParagraph('p1'));
    const wrapper = document.createElement('div');
    registry.setWrapper('p1', wrapper);
    expect(registry.get('p1')?.wrapper).toBe(wrapper);
  });

  it('setStatus 更新状态并记录 / 清除失败原因', () => {
    registry.register(makeParagraph('p1'));
    registry.setStatus('p1', 'translating');
    expect(registry.get('p1')?.status).toBe('translating');

    registry.setStatus('p1', 'error', '429 限流');
    expect(registry.get('p1')?.status).toBe('error');
    expect(registry.get('p1')?.errorReason).toBe('429 限流');

    // 离开 error 状态时清除原因
    registry.setStatus('p1', 'translated');
    expect(registry.get('p1')?.status).toBe('translated');
    expect(registry.get('p1')?.errorReason).toBeUndefined();
  });

  it('重复 register 同 id：保留已注入的 wrapper 与状态，仅刷新 node/sourceText', () => {
    registry.register(makeParagraph('p1', '旧原文'));
    registry.setStatus('p1', 'translated');
    const wrapper = document.createElement('div');
    registry.setWrapper('p1', wrapper);

    // SPA 重提取同段：node 引用换了，但状态/wrapper 不丢
    const refreshed = makeParagraph('p1', '新原文');
    registry.register(refreshed);

    const entry = registry.get('p1');
    expect(entry?.node).toBe(refreshed.node);
    expect(entry?.sourceText).toBe('新原文');
    expect(entry?.status).toBe('translated');
    expect(entry?.wrapper).toBe(wrapper);
    expect(registry.size).toBe(1);
  });

  it('entries 迭代全部登记项', () => {
    registry.registerMany([makeParagraph('a'), makeParagraph('b')]);
    const ids = Array.from(registry.entries()).map((e) => e.id).sort();
    expect(ids).toEqual(['a', 'b']);
  });

  it('remove / clear', () => {
    registry.registerMany([makeParagraph('a'), makeParagraph('b')]);
    registry.remove('a');
    expect(registry.has('a')).toBe(false);
    expect(registry.size).toBe(1);

    registry.clear();
    expect(registry.size).toBe(0);
  });

  it('对未登记 id 的写操作安全无副作用', () => {
    expect(() => registry.setWrapper('ghost', document.createElement('div'))).not.toThrow();
    expect(() => registry.setStatus('ghost', 'translated')).not.toThrow();
    expect(registry.get('ghost')).toBeUndefined();
  });
});
