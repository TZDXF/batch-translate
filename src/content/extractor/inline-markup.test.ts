import { describe, it, expect, beforeEach } from 'vitest';
import { serialize, restore, countInlineTags, isInlineElement } from './inline-markup';

beforeEach(() => {
  document.body.innerHTML = '';
});

function fromHTML(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

describe('isInlineElement', () => {
  it('识别内联标签', () => {
    expect(isInlineElement(fromHTML('<a>x</a>'))).toBe(true);
    expect(isInlineElement(fromHTML('<code>x</code>'))).toBe(true);
    expect(isInlineElement(fromHTML('<strong>x</strong>'))).toBe(true);
    expect(isInlineElement(fromHTML('<div>x</div>'))).toBe(false);
    expect(isInlineElement(fromHTML('<p>x</p>'))).toBe(false);
  });
});

describe('serialize', () => {
  it('把内联标签提取为 [[n]] 占位符，保留属性与内部文本', () => {
    const p = fromHTML('<p>Hello <a href="/x" title="t">world</a>!</p>');
    const { text, placeholders } = serialize(p);
    expect(text).toBe('Hello [[0]]!');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]!.index).toBe(0);
    expect(placeholders[0]!.node.tag).toBe('a');
    expect(placeholders[0]!.node.attrs).toContainEqual(['href', '/x']);
    expect(placeholders[0]!.node.attrs).toContainEqual(['title', 't']);
    expect(placeholders[0]!.node.children).toEqual(['world']);
  });

  it('嵌套内联：内层标签收纳在父占位符的 children 中', () => {
    const p = fromHTML('<p>a <strong>b <em>c</em></strong> d</p>');
    const { text, placeholders } = serialize(p);
    expect(text).toBe('a [[0]] d');
    expect(placeholders).toHaveLength(2);
    // 外层 strong（序号小，先于内层 em 分配）。
    expect(placeholders[0]!.node.tag).toBe('strong');
    expect(placeholders[0]!.node.children).toEqual(['b ', { ph: 1 }]);
    // 内层 em 通过 { ph: 1 } 引用。
    expect(placeholders[1]!.node.tag).toBe('em');
    expect(placeholders[1]!.node.children).toEqual(['c']);
  });

  it('纯文本段落无占位符', () => {
    const { text, placeholders } = serialize(fromHTML('<p>just plain text</p>'));
    expect(text).toBe('just plain text');
    expect(placeholders).toHaveLength(0);
  });

  it('连续内联标签各得独立占位符', () => {
    const p = fromHTML('<p>x <a>A</a><strong>B</strong> y</p>');
    const { text, placeholders } = serialize(p);
    expect(text).toBe('x [[0]][[1]] y');
    expect(placeholders.map((ph) => ph.node.tag)).toEqual(['a', 'strong']);
  });
});

describe('restore', () => {
  it('回填重建内联 DOM：标签数量与提取时一致', () => {
    const p = fromHTML('<p>Hello <a href="/x">world</a> and <strong>bold</strong>!</p>');
    const { text, placeholders } = serialize(p);
    expect(text).toBe('Hello [[0]] and [[1]]!');
    expect(countInlineTags(placeholders)).toBe(2);

    const frag = restore(text, placeholders);
    expect(frag.querySelectorAll('a, strong')).toHaveLength(2);
    expect(frag.querySelector('a')?.getAttribute('href')).toBe('/x');
    expect(frag.querySelector('a')?.textContent).toBe('world');
    expect(frag.querySelector('strong')?.textContent).toBe('bold');
  });

  it('嵌套内联回填：重建嵌套结构', () => {
    const p = fromHTML('<p>a <strong>b <em>c</em></strong> d</p>');
    const { text, placeholders } = serialize(p);
    const frag = restore('X ' + text + ' Y', placeholders);
    // 标签总数一致（strong + em = 2）。
    expect(frag.querySelectorAll('strong, em')).toHaveLength(2);
    const strong = frag.querySelector('strong');
    expect(strong?.querySelector('em')?.textContent).toBe('c');
    expect(strong?.textContent).toBe('b c');
  });

  it('翻译后回填：占位符可在译文中移动', () => {
    const p = fromHTML('<p>Hello <a href="/x">world</a></p>');
    const { placeholders } = serialize(p);
    const frag = restore('你好 [[0]]', placeholders);
    expect(frag.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect((frag.firstChild as Text).nodeValue).toBe('你好 ');
    expect(frag.querySelector('a')?.textContent).toBe('world');
    expect(frag.querySelector('a')?.getAttribute('href')).toBe('/x');
  });

  it('往返：serialize → restore 文本内容保持', () => {
    const p = fromHTML('<p>Visit <a href="https://e.com">our site</a> now.</p>');
    const { text, placeholders } = serialize(p);
    const frag = restore(text, placeholders);
    expect(frag.textContent).toBe('Visit our site now.');
  });

  it('缺失占位符优雅降级（原样保留为字面量）', () => {
    const frag = restore('text [[9]] end', []);
    expect(frag.textContent).toBe('text [[9]] end');
  });

  it('自定义 doc 注入（不依赖全局 document）', () => {
    const p = fromHTML('<p>x <code>y</code></p>');
    const { text, placeholders } = serialize(p);
    const frag = restore(text, placeholders, document);
    expect(frag.querySelector('code')?.textContent).toBe('y');
  });
});
