import { describe, it, expect, beforeEach } from 'vitest';
import { extract, hashId } from './dom-walker';
import { restore } from './inline-markup';

/** 综合 fixture：覆盖正文 / 包裹容器 / 代码 / 脚本 / 隐藏 / 可编辑 / 表单 / 已翻译 / 导航。 */
const FIXTURE = `
<main>
  <h1>Title here</h1>
  <p>First paragraph with some text.</p>
  <p>Second with a <a href="/link">link</a> inside.</p>
  <div><p>Nested paragraph should not double count.</p></div>
  <pre>const code = 'not translated';</pre>
  <script>var malicious = 1;</script>
  <style>.x { color: red; }</style>
  <noscript>fallback text</noscript>
  <p style="display:none">hidden paragraph</p>
  <p aria-hidden="true">aria hidden text</p>
  <div contenteditable="true">editable content</div>
  <input value="form value" />
  <p data-bt-paragraph-id="bt_x">already translated text</p>
  <blockquote>A quote to translate here.</blockquote>
  <nav><p>Home About Contact</p></nav>
</main>
`;

function texts(paragraphs: ReturnType<typeof extract>): string[] {
  return paragraphs.map((p) => p.text);
}

describe('extract — 综合 fixture', () => {
  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
  });

  it('提取正文段落，排除 script / style / noscript 内容', () => {
    const joined = texts(extract(document.body)).join('|');
    expect(joined).not.toContain('malicious');
    expect(joined).not.toContain('color');
    expect(joined).not.toContain('fallback text');
    expect(joined).toContain('First paragraph with some text.');
    expect(joined).toContain('Title here');
  });

  it('不重复提取包裹容器与其子段落（去重）', () => {
    const nested = extract(document.body).filter((p) =>
      p.text.includes('Nested paragraph'),
    );
    expect(nested).toHaveLength(1);
  });

  it('跳过隐藏节点', () => {
    const joined = texts(extract(document.body)).join('|');
    expect(joined).not.toContain('hidden paragraph');
    expect(joined).not.toContain('aria hidden text');
  });

  it('跳过 contenteditable 与表单', () => {
    const joined = texts(extract(document.body)).join('|');
    expect(joined).not.toContain('editable content');
    expect(joined).not.toContain('form value');
  });

  it('跳过已翻译节点（避免重复注入）', () => {
    const joined = texts(extract(document.body)).join('|');
    expect(joined).not.toContain('already translated text');
  });

  it('code（pre）不译：不出现在提取结果', () => {
    const joined = texts(extract(document.body)).join('|');
    expect(joined).not.toContain("const code = 'not translated'");
  });

  it('分类：blockquote → content，nav → nav', () => {
    const paragraphs = extract(document.body);
    const quote = paragraphs.find((p) => p.text.includes('quote to translate'));
    expect(quote?.category).toBe('content');
    const navItem = paragraphs.find((p) => p.text.includes('Home About Contact'));
    expect(navItem?.category).toBe('nav');
  });

  it('translateNav=true 时导航分类为 content', () => {
    const paragraphs = extract(document.body, { translateNav: true });
    const navItem = paragraphs.find((p) => p.text.includes('Home About Contact'));
    expect(navItem?.category).toBe('content');
  });

  it('稳定 id：相同 DOM 重复提取 id 完全一致', () => {
    const a = extract(document.body);
    const b = extract(document.body);
    expect(a.map((p) => p.id)).toEqual(b.map((p) => p.id));
    expect(a.length).toBeGreaterThan(0);
    expect(a[0]!.id).toMatch(/^bt_[0-9a-z]+$/);
  });

  it('id 唯一（无重复）', () => {
    const paragraphs = extract(document.body);
    const idList = paragraphs.map((p) => p.id);
    expect(new Set(idList).size).toBe(idList.length);
  });
});

describe('extract — 隔离场景', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('内联标签被占位符保护', () => {
    document.body.innerHTML = '<main><p>Click <a href="/x">here</a> to continue.</p></main>';
    const [p] = extract(document.body);
    expect(p!.text).toBe('Click [[0]] to continue.');
    expect(p!.placeholders).toHaveLength(1);
    expect(p!.placeholders![0]!.node.tag).toBe('a');
  });

  it('占位符回填后内联标签数量与提取时一致', () => {
    document.body.innerHTML =
      '<main><p>One <a href="/1">l1</a> two <strong>s</strong> three <em>e</em>.</p></main>';
    const [p] = extract(document.body);
    expect(p).toBeDefined();
    expect(p!.placeholders).toHaveLength(3);
    const frag = restore(p!.text, p!.placeholders!);
    expect(frag.querySelectorAll('a, strong, em')).toHaveLength(3);
  });

  it('只读：不改动原节点属性 / 类 / 结构', () => {
    document.body.innerHTML =
      '<main><p id="keep" class="orig" data-x="1">Text <a href="/l">link</a></p></main>';
    const p = document.body.querySelector('p') as Element;
    const before = p.outerHTML;
    extract(document.body);
    expect(p.outerHTML).toBe(before);
    expect(p.getAttribute('class')).toBe('orig');
    expect(p.getAttribute('data-x')).toBe('1');
  });

  it('正文区选择：优先 main，main 外的段落不提取', () => {
    document.body.innerHTML = '<p>outside main text</p><main><p>inside main text</p></main>';
    const joined = texts(extract(document.body));
    expect(joined).toContain('inside main text');
    expect(joined).not.toContain('outside main text');
  });

  it('fallback：无 main/article 时用传入根', () => {
    document.body.innerHTML = '<div><p>Just a paragraph here.</p></div>';
    const joined = texts(extract(document.body));
    expect(joined).toContain('Just a paragraph here.');
  });

  it('skipSelectors：用户黑名单强制跳过', () => {
    document.body.innerHTML =
      '<main><p>Translate this paragraph.</p><p class="nope">Skip me please.</p></main>';
    const joined = texts(extract(document.body, { skipSelectors: ['.nope'] }));
    expect(joined).toContain('Translate this paragraph.');
    expect(joined).not.toContain('Skip me please.');
  });
});

describe('hashId', () => {
  it('顺序 + 文本共同决定 id', () => {
    expect(hashId(0, 'hello')).toBe(hashId(0, 'hello'));
    expect(hashId(0, 'hello')).not.toBe(hashId(1, 'hello'));
    expect(hashId(0, 'hello')).not.toBe(hashId(0, 'world'));
  });

  it('空白规范化不影响 id（提取可复现）', () => {
    expect(hashId(0, 'a  b')).toBe(hashId(0, 'a b'));
  });
});
