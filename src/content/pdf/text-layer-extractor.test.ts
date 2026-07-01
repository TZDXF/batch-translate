/**
 * text-layer-extractor 单测（P2-1 / TRA-24）。
 *
 * 覆盖纯函数 extractPdfParagraphs / extractPdfParagraphsMultiPage / toItems 的：
 *  - 行归并（同基线 top 在容差内 → 一行）
 *  - 行内 item 按 left 排序连接（CJK 不留空格、其余单空格）
 *  - 段落断行（垂直间距超阈值 → 新段）
 *  - 页码样 item 过滤
 *  - 稳定 id（hashId，跨重排幂等）+ 跨页去重
 *  - 空文本层 → []（扫描版兜底入口）
 *  - DOM 适配 collectTextItems（jsdom）
 */
import { describe, expect, it } from 'vitest';
import {
  collectTextItems,
  extractPdfParagraphs,
  extractPdfParagraphsMultiPage,
  toItems,
  type PdfTextItem,
} from './text-layer-extractor';

/** 便捷构造 item。 */
function item(text: string, left: number, top: number, w = 50, h = 16): PdfTextItem {
  return { text, left, top, width: w, height: h };
}

describe('extractPdfParagraphs：行归并', () => {
  it('同一基线 top 的多个 item 归为一行，按 left 排序连接', () => {
    // 三个 item 同 top，顺序打乱 → 一行一段。
    const items = [
      item('world', 60, 100),
      item('Hello', 10, 100),
      item('pdf', 30, 100),
    ];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(1);
    // left 升序：Hello pdf world
    expect(p[0]?.text).toBe('Hello pdf world');
  });

  it('top 差在容差内仍归同行（默认容差 = 行高一半）', () => {
    const items = [item('A', 10, 100), item('B', 60, 107)]; // 7px 差 < 8 (16/2)
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(1);
    expect(p[0]?.text).toBe('A B');
  });

  it('top 差超过容差 → 不同行', () => {
    const items = [item('A', 10, 100), item('B', 60, 130)]; // 30px 差 > 8
    const p = extractPdfParagraphs(items, 800, 0);
    // 30px 仍可能同段（gap 阈值 0.8*16=12.8 → 30-16=14 > 12.8 → 断段）
    expect(p).toHaveLength(2);
    expect(p[0]?.text).toBe('A');
    expect(p[1]?.text).toBe('B');
  });
});

describe('extractPdfParagraphs：CJK 连接', () => {
  it('CJK item 之间不留空格', () => {
    const items = [item('机器翻译', 10, 100), item('是子领域', 90, 100)];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p[0]?.text).toBe('机器翻译是子领域');
  });

  it('CJK 与拉丁之间留单空格', () => {
    const items = [item('使用', 10, 100), item('LLM', 50, 100), item('翻译', 90, 100)];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p[0]?.text).toBe('使用 LLM 翻译');
  });
});

describe('extractPdfParagraphs：段落断行', () => {
  it('行间距小 → 合并为一段（换行连接）', () => {
    // 两行紧贴：行2 top=120，行1 bottom=116，gap=4 < 12.8 → 同段
    const items = [
      item('Line one', 10, 100),
      item('Line two', 10, 120),
    ];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(1);
    expect(p[0]?.text).toBe('Line one\nLine two');
  });

  it('行间距大 → 断为两段', () => {
    // 行2 top=160，行1 bottom=116，gap=44 > 12.8 → 断段
    const items = [
      item('First paragraph', 10, 100),
      item('Second paragraph', 10, 160),
    ];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(2);
  });

  it('paragraphGap=Infinity → 所有行合并一段', () => {
    const items = [
      item('A', 10, 100),
      item('B', 10, 300),
    ];
    const p = extractPdfParagraphs(items, 800, 0, { paragraphGap: Infinity });
    expect(p).toHaveLength(1);
  });
});

describe('extractPdfParagraphs：页码过滤', () => {
  it('底部短数字行被当页码过滤', () => {
    const items = [
      item('Body text content here', 10, 100),
      item('12', 300, 720), // 页面高 800，底部 12% = 704 起
    ];
    const p = extractPdfParagraphs(items, 800, 0, { skipPageNumbers: true });
    expect(p).toHaveLength(1);
    expect(p[0]?.text).toBe('Body text content here');
  });

  it('skipPageNumbers=false → 保留页码行', () => {
    const items = [item('Body', 10, 100), item('12', 300, 720)];
    const p = extractPdfParagraphs(items, 800, 0, { skipPageNumbers: false });
    expect(p).toHaveLength(2);
  });

  it('正文区出现的数字行不算页码', () => {
    const items = [item('42', 10, 100)]; // top=100 远离底部
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(1);
    expect(p[0]?.text).toBe('42');
  });
});

describe('extractPdfParagraphs：稳定 id + 每位置独立', () => {
  it('相同输入产出相同 id（跨重排幂等）', () => {
    const items = [item('Same text', 10, 100)];
    const a = extractPdfParagraphs(items, 800, 0);
    const b = extractPdfParagraphs(items, 800, 0);
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.id).toMatch(/^bt_/);
  });

  it('同页内重复文本不同位置 → 两个独立段落（各自 overlay）', () => {
    const items = [
      item('Repeated', 10, 100),
      item('Repeated', 10, 200), // 同文本不同位置
    ];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p).toHaveLength(2);
    // 两个出现位置 id 不同（order 不同），各自有自己的 rect。
    expect(p[0]?.id).not.toBe(p[1]?.id);
  });
});

describe('extractPdfParagraphs：边界', () => {
  it('空 items → []（扫描版兜底）', () => {
    expect(extractPdfParagraphs([], 800, 0)).toEqual([]);
  });

  it('全空文本 item → []', () => {
    const items = [item('   ', 10, 100), item('', 50, 100)];
    expect(extractPdfParagraphs(items, 800, 0)).toEqual([]);
  });

  it('段落 rect 为所属 item 并集', () => {
    const items = [item('AB', 10, 100, 40, 16), item('CD', 60, 100, 30, 16)];
    const p = extractPdfParagraphs(items, 800, 0);
    expect(p[0]?.rect).toEqual({ left: 10, top: 100, right: 90, bottom: 116 });
  });
});

describe('extractPdfParagraphsMultiPage：跨页', () => {
  it('多页段落合并，跨页重复文本各拿独立 id（各自 overlay）', () => {
    const pages = [
      { items: [item('Shared text', 10, 100)], pageHeight: 800, page: 0 },
      { items: [item('Shared text', 10, 100), item('Page two only', 10, 200)], pageHeight: 800, page: 1 },
    ];
    const p = extractPdfParagraphsMultiPage(pages);
    // Shared text 在两页各出现一次 → 两个独立段落 + Page two only → 共 3 段。
    expect(p).toHaveLength(3);
    expect(p[0]?.page).toBe(0);
    expect(p[0]?.text).toBe('Shared text');
    expect(p[1]?.page).toBe(1);
    expect(p[1]?.text).toBe('Shared text');
    expect(p[0]?.id).not.toBe(p[1]?.id); // 跨页同文本独立 id
    expect(p[2]?.text).toBe('Page two only');
  });
});

describe('toItems：投影为翻译协议 Item', () => {
  it('仅保留 id + text，丢弃 DOM 引用 / rect', () => {
    const items = [item('Hello', 10, 100)];
    const p = extractPdfParagraphs(items, 800, 0);
    const its = toItems(p);
    expect(its).toEqual([{ id: p[0]?.id, text: 'Hello' }]);
    expect(its[0]).not.toHaveProperty('rect');
    expect(its[0]).not.toHaveProperty('items');
  });
});

describe('collectTextItems：DOM 适配（jsdom）', () => {
  it('从 .textLayer 读取 span 为 PdfTextItem', () => {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    layer.style.position = 'relative';
    layer.style.width = '600px';
    layer.style.height = '800px';
    const s1 = document.createElement('span');
    s1.textContent = 'Hello PDF';
    s1.style.left = '10px';
    s1.style.top = '100px';
    s1.style.position = 'absolute';
    const s2 = document.createElement('span');
    s2.textContent = 'World';
    s2.style.left = '60px';
    s2.style.top = '100px';
    s2.style.position = 'absolute';
    layer.append(s1, s2);
    document.body.appendChild(layer);

    const items = collectTextItems(layer);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text)).toEqual(['Hello PDF', 'World']);
    expect(items.every((i) => i.element instanceof HTMLElement)).toBe(true);
  });

  it('跳过空文本 span', () => {
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    const s1 = document.createElement('span');
    s1.textContent = 'Keep';
    const s2 = document.createElement('span');
    s2.textContent = '   ';
    layer.append(s1, s2);
    document.body.appendChild(layer);
    const items = collectTextItems(layer);
    expect(items).toHaveLength(1);
    expect(items[0]?.text).toBe('Keep');
  });
});
