import { describe, it, expect, beforeEach } from 'vitest';
import { classify, isCode, isNav, isLikelyUntranslatable } from './block-classifier';

beforeEach(() => {
  document.body.innerHTML = '';
});

function el(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

describe('classify', () => {
  it('正文段落 → content', () => {
    expect(classify(el('<p>This is a normal paragraph of content.</p>'))).toBe('content');
  });

  it('导航区域 → nav（默认不译）；translateNav 时 → content', () => {
    document.body.innerHTML = '<nav><p>Home About Contact us</p></nav>';
    const p = document.body.querySelector('p') as Element;
    expect(classify(p)).toBe('nav');
    expect(classify(p, { translateNav: true })).toBe('content');
  });

  it('页脚 → nav', () => {
    document.body.innerHTML = '<footer><p>Privacy Terms and conditions</p></footer>';
    const p = document.body.querySelector('p') as Element;
    expect(classify(p)).toBe('nav');
  });

  it('代码块 → code（pre / 高亮 class）', () => {
    expect(classify(el('<pre>const x = 1;</pre>'))).toBe('code');
    expect(classify(el('<div class="language-python">print(1)</div>'))).toBe('code');
    expect(classify(el('<div class="highlight"><code>foo</code></div>'))).toBe('code');
    expect(classify(el('<div class="hljs-wrap">x</div>'))).toBe('code');
  });

  it('不可译内容 → skip（空白 / 过短 / 纯数字 / 纯标点 / URL）', () => {
    expect(classify(el('<p>   </p>'))).toBe('skip');
    expect(classify(el('<p>x</p>'))).toBe('skip'); // < minChars(2)
    expect(classify(el('<p>123</p>'))).toBe('skip'); // 纯数字
    expect(classify(el('<p>!!!???</p>'))).toBe('skip'); // 纯标点
    expect(classify(el('<p>https://example.com</p>'))).toBe('skip'); // URL
  });

  it('minChars 可配', () => {
    expect(classify(el('<p>ab</p>'), { minChars: 3 })).toBe('skip');
    expect(classify(el('<p>abc</p>'), { minChars: 3 })).toBe('content');
  });
});

describe('isCode / isNav / isLikelyUntranslatable', () => {
  it('isCode', () => {
    expect(isCode(el('<pre>x</pre>'))).toBe(true);
    expect(isCode(el('<svg><text>x</text></svg>'))).toBe(true);
    expect(isCode(el('<p>normal</p>'))).toBe(false);
  });

  it('isNav：链接列表', () => {
    const ul = el('<ul><li><a>A</a></li><li><a>B</a></li><li><a>C</a></li></ul>');
    expect(isNav(ul)).toBe(true);
    const prose = el('<ul><li>Just a bullet of prose here</li><li>Another bullet item</li></ul>');
    expect(isNav(prose)).toBe(false);
  });

  it('isLikelyUntranslatable', () => {
    expect(isLikelyUntranslatable('')).toBe(true);
    expect(isLikelyUntranslatable('Hello world')).toBe(false);
    expect(isLikelyUntranslatable('---')).toBe(true);
  });
});
