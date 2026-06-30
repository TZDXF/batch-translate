import { describe, it, expect, beforeEach } from 'vitest';
import { render, renderError, ensureStyles } from './bilingual-renderer';
import type { Paragraph } from '../../shared/types';

function makeParagraph(id: string, text = 'Hello world.'): Paragraph {
  const node = document.createElement('p');
  node.textContent = text;
  return { id, node, text };
}

function attrSnapshot(el: Element): Record<string, string> {
  const obj: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) obj[a.name] = a.value;
  return obj;
}

describe('bilingual-renderer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  describe('注入不破坏原节点（核心契约）', () => {
    it('render 后原节点的属性 / 类 / style 零改动，wrapper 紧随其后', () => {
      const p = document.createElement('p');
      p.id = 'orig-1';
      p.className = 'article-body lead';
      p.setAttribute('data-track', 'xyz');
      p.setAttribute('aria-label', 'hi');
      p.style.color = 'red';
      p.style.fontSize = '16px';
      p.textContent = 'Hello world.';
      document.body.appendChild(p);

      const beforeAttrs = attrSnapshot(p);
      const beforeClass = p.className;
      const beforeStyle = p.style.cssText;

      const handle = render({ id: 'p1', node: p, text: 'Hello world.' }, '你好，世界。');

      // 1. 原节点属性 / 类 / style 完全不变
      expect(attrSnapshot(p)).toEqual(beforeAttrs);
      expect(p.className).toBe(beforeClass);
      expect(p.style.cssText).toBe(beforeStyle);
      expect(p.getAttribute('data-track')).toBe('xyz');

      // 2. wrapper 紧跟原节点之后
      expect(p.nextElementSibling).toBe(handle.wrapper);

      // 3. wrapper 是 div.bt-translation，带段落 id 与标记属性
      expect(handle.wrapper.tagName).toBe('DIV');
      expect(handle.wrapper.className).toBe('bt-translation');
      expect(handle.wrapper.dataset.btId).toBe('p1');
      expect(handle.wrapper.hasAttribute('data-bt-translation')).toBe(true);

      // 4. 译文内容正确
      expect(handle.wrapper.textContent).toBe('你好，世界。');
    });
  });

  describe('容器感知：表格 / flex 不破结构', () => {
    it('表格 cell 内段落：wrapper 落在 td 内，tr 直接子级仍只有 cell', () => {
      const table = document.createElement('table');
      const tbody = document.createElement('tbody');
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      const p = document.createElement('p');
      p.textContent = 'cell text';
      td.appendChild(p);
      tr.appendChild(td);
      tbody.appendChild(tr);
      table.appendChild(tbody);
      document.body.appendChild(table);

      const handle = render({ id: 'td-p', node: p, text: 'cell text' }, '单元格文本');

      // wrapper 在 td 内（p 之后）
      expect(handle.wrapper.parentElement).toBe(td);
      expect(p.parentElement).toBe(td);
      // tr 直接子级仍只有 td —— 没有把 div 塞进表格行结构
      expect(Array.from(tr.children)).toEqual([td]);
      expect(td.children.length).toBe(2); // p + wrapper
    });

    it('flex item：wrapper 插到 item 内部，不新增 flex item', () => {
      const flex = document.createElement('div');
      flex.style.display = 'flex';
      const item = document.createElement('div');
      item.textContent = 'item';
      flex.appendChild(item);
      document.body.appendChild(flex);

      const handle = render({ id: 'fx', node: item, text: 'item' }, '条目');

      // wrapper 作为 item 的子节点，flex 容器直接子级仍只有 item
      expect(handle.wrapper.parentElement).toBe(item);
      expect(Array.from(flex.children)).toEqual([item]);
    });

    it('grid item：同 flex，wrapper 插到 item 内部', () => {
      const grid = document.createElement('div');
      grid.style.display = 'grid';
      const item = document.createElement('div');
      item.textContent = 'g';
      grid.appendChild(item);
      document.body.appendChild(grid);

      const handle = render({ id: 'gd', node: item, text: 'g' }, '格');

      expect(handle.wrapper.parentElement).toBe(item);
      expect(Array.from(grid.children)).toEqual([item]);
    });
  });

  describe('showOriginal 显示模式切换', () => {
    it('bilingual(默认) 双显；original 隐藏译文；translation 隐藏原文；可逆', () => {
      const p = document.createElement('p');
      p.textContent = 'original';
      document.body.appendChild(p);

      const handle = render({ id: 'p1', node: p, text: 'original' }, '译文');

      // 默认 bilingual：译文可见、原文未受影响
      expect(handle.wrapper.classList.contains('bt-translation--hidden')).toBe(false);
      expect(p.getAttribute('data-bt-original')).toBeNull();

      // 仅原文：隐藏译文（动 wrapper，不动原节点）
      handle.setDisplayMode('original');
      expect(handle.wrapper.classList.contains('bt-translation--hidden')).toBe(true);
      expect(p.getAttribute('data-bt-original')).toBeNull();

      // 仅译文：原文隐藏（可逆 data 属性）
      handle.setDisplayMode('translation');
      expect(p.getAttribute('data-bt-original')).toBe('hidden');
      expect(handle.wrapper.classList.contains('bt-translation--hidden')).toBe(false);

      // 切回双显：原文恢复
      handle.setDisplayMode('bilingual');
      expect(p.getAttribute('data-bt-original')).toBeNull();
      expect(handle.wrapper.classList.contains('bt-translation--hidden')).toBe(false);
    });
  });

  describe('译文样式预设', () => {
    it('切换 style：旧修饰类移除、新修饰类加上', () => {
      const p = document.createElement('p');
      document.body.appendChild(p);
      const handle = render(makeParagraph('p1'), '译文');

      expect(handle.wrapper.classList.contains('bt-translation--highlight')).toBe(false);

      handle.setStyle('highlight');
      expect(handle.wrapper.classList.contains('bt-translation--highlight')).toBe(true);

      handle.setStyle('underline');
      expect(handle.wrapper.classList.contains('bt-translation--highlight')).toBe(false);
      expect(handle.wrapper.classList.contains('bt-translation--underline')).toBe(true);
    });

    it('可在 render 时指定初始 style', () => {
      const p = document.createElement('p');
      document.body.appendChild(p);
      const handle = render(makeParagraph('p1'), '译文', { style: 'blur' });
      expect(handle.wrapper.classList.contains('bt-translation--blur')).toBe(true);
    });
  });

  describe('失败段落原位错误占位', () => {
    it('renderError 显示错误占位，不影响原文与其他段', () => {
      const p = document.createElement('p');
      p.textContent = 'fail me';
      document.body.appendChild(p);

      const handle = renderError(makeParagraph('p1'), '429 限流');

      expect(handle.wrapper.classList.contains('bt-translation--error')).toBe(true);
      expect(handle.wrapper.textContent).toContain('翻译失败');
      expect(handle.wrapper.textContent).toContain('429 限流');
      // 原文未被改动
      expect(p.textContent).toBe('fail me');
    });

    it('markError / clearError 在已渲染 wrapper 上可逆', () => {
      const p = document.createElement('p');
      document.body.appendChild(p);
      const handle = render(makeParagraph('p1'), '你好');

      handle.markError('超时');
      expect(handle.wrapper.classList.contains('bt-translation--error')).toBe(true);
      expect(handle.wrapper.textContent).toContain('超时');

      handle.clearError();
      expect(handle.wrapper.classList.contains('bt-translation--error')).toBe(false);
      expect(handle.wrapper.textContent).toBe('你好');
    });
  });

  describe('流式追加（P1 接口）', () => {
    it('appendChunk 累加译文文本', () => {
      const p = document.createElement('p');
      document.body.appendChild(p);
      const handle = render(makeParagraph('p1'), '');

      handle.appendChunk('你');
      handle.appendChunk('好');
      expect(handle.wrapper.textContent).toBe('你好');

      handle.appendChunk('，世界');
      expect(handle.wrapper.textContent).toBe('你好，世界');
    });

    it('setText 整段替换（重译 / 缓存命中回填）', () => {
      const p = document.createElement('p');
      document.body.appendChild(p);
      const handle = render(makeParagraph('p1'), '旧译文');

      handle.setText('全新译文');
      expect(handle.wrapper.textContent).toBe('全新译文');
    });
  });

  describe('inline-markup 还原钩子（P0-8 委托）', () => {
    it('提供 restoreMarkup 时按钩子还原 DOM；未提供则纯文本', () => {
      const p1 = document.createElement('p');
      document.body.appendChild(p1);
      // 模拟 P0-8：把 [[0]] 占位符还原成 <strong>
      const restoreMarkup = (t: string): Node[] => {
        return t
          .split(/(\[\[\d+\]\])/)
          .filter(Boolean)
          .map((part) => {
            const m = part.match(/^\[\[(\d+)\]\]$/);
            if (m) {
              const s = document.createElement('strong');
              s.textContent = m[1]!;
              return s;
            }
            return document.createTextNode(part);
          });
      };

      const handle = render(makeParagraph('p1'), '你好[[0]]世界', { restoreMarkup });
      const strong = handle.wrapper.querySelector('strong');
      expect(strong).not.toBeNull();
      expect(strong?.textContent).toBe('0');

      // 未提供钩子：占位符原样显示为纯文本
      const p2 = document.createElement('p');
      document.body.appendChild(p2);
      const plain = render(makeParagraph('p2'), '你好[[0]]世界');
      expect(plain.wrapper.querySelector('strong')).toBeNull();
      expect(plain.wrapper.textContent).toBe('你好[[0]]世界');
    });
  });

  describe('ensureStyles 幂等', () => {
    it('多次调用只注入一份样式表', () => {
      ensureStyles();
      ensureStyles();
      ensureStyles();
      expect(document.querySelectorAll('#bt-runtime-styles').length).toBe(1);
    });
  });
});
