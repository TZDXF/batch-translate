/**
 * content 侧渲染集成测试（P0-12 / TRA-13 收尾）：dom-walker 提取 → bilingual-renderer 注入
 * → inline-markup 占位符还原 → layout-guard 容器感知插入。
 *
 * 验证交付物 #1 translate-page 的核心契约（jsdom 环境）：
 *  - 双语对照渲染：原段落后插入 .bt-translation wrapper。
 *  - 原文属性未改：原节点 class/style/属性零污染。
 *  - 段落数量对齐：提取数 = 渲染数。
 *  - 内联标记保护：[[n]] 占位符还原为内联 DOM（a/strong/em），数量一致。
 *  - 代码块不译：<pre><code> 被跳过。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { extract } from '../extractor/dom-walker';
import { restore } from '../extractor/inline-markup';
import { render } from '../renderer/bilingual-renderer';

function fixtureDoc(): void {
  document.body.innerHTML = `
    <main>
      <article>
        <h1>Machine Translation</h1>
        <p id="p1">Machine translation translates text from one language to another.</p>
        <p id="p2">Early systems used <strong>rules</strong> and <a href="https://example.com">dictionaries</a>.</p>
        <p id="p3">Modern systems use large <em>neural</em> networks.</p>
        <pre><code>const x = 42;</code></pre>
        <p id="p4">This is the final paragraph of the article.</p>
      </article>
    </main>
  `;
}

describe('渲染集成：提取 → 渲染 → 双语对照', () => {
  beforeEach(() => {
    fixtureDoc();
  });

  it('提取跳过代码块，段落数量与可译块对齐', () => {
    const paragraphs = extract(document.body);
    // h1 + 4 个 p（pre/code 被跳过）。
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    // 代码块未被提取为段落。
    expect(paragraphs.some((p) => p.text.includes('const x'))).toBe(false);
  });

  it('双语渲染：原段落后插入 .bt-translation，原文属性零污染', () => {
    const paragraphs = extract(document.body);
    const target = paragraphs.find((p) => p.element?.id === 'p1')!;
    const before = snapshotAttrs(target.element as HTMLElement);

    const handle = render(
      { id: target.id, text: target.text, node: target.element as HTMLElement },
      '机器翻译把文本从一种语言翻译成另一种。',
    );

    // wrapper 插在原节点之后。
    const wrapper = handle.wrapper;
    expect(wrapper.className).toBe('bt-translation');
    expect(wrapper.parentElement).toBe((target.element as HTMLElement).parentElement);
    expect(wrapper.previousElementSibling).toBe(target.element);
    expect(wrapper.textContent).toContain('机器翻译');

    // ★ 原文属性零污染：渲染前后属性快照一致。
    expect(snapshotAttrs(target.element as HTMLElement)).toEqual(before);
  });

  it('内联标记保护：[[n]] 占位符还原为内联 DOM（a/strong/em），数量一致', () => {
    const paragraphs = extract(document.body);
    const target = paragraphs.find((p) => p.element?.id === 'p2')!;
    // 译文保留占位符（模拟 LLM verbatim 返回）。
    const translated = '早期系统使用 [[0]] 和 [[1]]。';
    const placeholders = target.placeholders ?? [];

    const handle = render(
      { id: target.id, text: target.text, node: target.element as HTMLElement },
      translated,
      { restoreMarkup: (text) => [restore(text, placeholders, document)] },
    );

    const wrapper = handle.wrapper;
    // 还原出 strong + a 两个内联元素。
    expect(wrapper.querySelector('strong')).not.toBeNull();
    const anchor = wrapper.querySelector('a');
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute('href')).toBe('https://example.com');
    // 占位符数量 = 还原出的内联元素数量。
    expect(wrapper.querySelectorAll('strong, a, em').length).toBe(placeholders.length);
  });

  it('段落数量对齐：每个提取段落都注入一个 wrapper', () => {
    const paragraphs = extract(document.body);
    const handles = paragraphs.map((p) =>
      render({ id: p.id, text: p.text, node: p.element as HTMLElement }, `译-${p.id}`),
    );
    expect(handles.length).toBe(paragraphs.length);
    expect(document.querySelectorAll('.bt-translation').length).toBe(paragraphs.length);
    // 每个 wrapper 紧跟其原段落。
    for (const p of paragraphs) {
      const node = p.element as HTMLElement;
      const next = node.nextElementSibling;
      expect(next?.classList.contains('bt-translation')).toBe(true);
    }
  });

  it('容器感知插入：表格行级不破结构（td 内插入）', () => {
    document.body.innerHTML = `
      <main>
        <table><tbody>
          <tr><td><p id="tp">Cell text here.</p></td></tr>
        </tbody></table>
      </main>
    `;
    const paragraphs = extract(document.body);
    const target = paragraphs.find((p) => p.element?.id === 'tp')!;
    const handle = render(
      { id: target.id, text: target.text, node: target.element as HTMLElement },
      '单元格文本。',
    );
    // wrapper 仍在 td 内（不破坏 table 结构）。
    expect(handle.wrapper.closest('td')).not.toBeNull();
  });
});

function snapshotAttrs(el: HTMLElement): string {
  return Array.from(el.attributes)
    .map((a) => `${a.name}=${a.value}`)
    .sort()
    .join('|');
}
