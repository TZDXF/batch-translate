/**
 * pdf-overlay-renderer 单测（P2-1 / TRA-24）。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  PdfTextLayerWatch,
  computeOverlayStyle,
  ensurePdfStyles,
  renderPdfOverlay,
  type PdfOverlayHandle,
} from './pdf-overlay-renderer';
import { extractPdfParagraphs, type PdfTextItem } from './text-layer-extractor';

function item(text: string, left: number, top: number, w = 50, h = 16): PdfTextItem {
  return { text, left, top, width: w, height: h };
}

describe('computeOverlayStyle：定位几何', () => {
  it('由 rect 计算 left/top/width（px）', () => {
    const s = computeOverlayStyle({ left: 10, top: 100, right: 110, bottom: 116 });
    expect(s).toEqual({ left: '10px', top: '100px', width: '100px' });
  });
  it('right < left 时 width 兜底 0', () => {
    const s = computeOverlayStyle({ left: 50, top: 100, right: 40, bottom: 116 });
    expect(s.width).toBe('0px');
  });
});

describe('renderPdfOverlay：DOM 注入', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function makeParagraph() {
    const items = [item('Hello PDF world', 10, 100, 120, 16)];
    return extractPdfParagraphs(items, 800, 0)[0]!;
  }

  it('在容器内创建绝对定位 bt-pdf-translation wrapper', () => {
    const container = document.createElement('div');
    container.style.position = 'relative';
    document.body.appendChild(container);
    const p = makeParagraph();
    const h = renderPdfOverlay(p, '你好 PDF 世界', container);
    expect(container.querySelector('.bt-pdf-translation')).toBeTruthy();
    expect(h.wrapper.style.left).toBe('10px');
    expect(h.wrapper.style.top).toBe('100px');
    expect(h.wrapper.style.width).toBe('120px');
    expect(h.wrapper.dataset.btId).toBe(p.id);
  });

  it('不触碰容器内既有 pdf.js 节点', () => {
    const container = document.createElement('div');
    container.style.position = 'relative';
    const span = document.createElement('span');
    span.textContent = 'orig';
    span.setAttribute('data-pdfjs', 'keep');
    container.appendChild(span);
    document.body.appendChild(container);
    renderPdfOverlay(makeParagraph(), '译文', container);
    // 原 span 属性 / 文本不变。
    const spanAfter = container.querySelector('span[data-pdfjs="keep"]');
    expect(spanAfter?.textContent).toBe('orig');
    expect(spanAfter?.getAttribute('data-pdfjs')).toBe('keep');
  });

  it('setText / appendChunk / markError / clearError / setDisplayMode / remove', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const p = makeParagraph();
    const h: PdfOverlayHandle = renderPdfOverlay(p, 'A', container);
    const text = () => h.wrapper.querySelector('.bt-pdf-translation__text')?.textContent ?? '';

    h.appendChunk('B');
    expect(text()).toBe('AB');
    h.setText('C');
    expect(text()).toBe('C');
    h.markError('boom');
    expect(h.wrapper.classList.contains('bt-pdf-translation--error')).toBe(true);
    expect(text()).toContain('翻译失败');
    h.clearError();
    expect(h.wrapper.classList.contains('bt-pdf-translation--error')).toBe(false);
    expect(text()).toBe('C');
    h.setDisplayMode('original');
    expect(h.wrapper.classList.contains('bt-pdf-translation--hidden')).toBe(true);
    h.setDisplayMode('bilingual');
    expect(h.wrapper.classList.contains('bt-pdf-translation--hidden')).toBe(false);
    h.remove();
    expect(container.querySelector('.bt-pdf-translation')).toBeNull();
  });

  it('displayMode=original 初始隐藏', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const h = renderPdfOverlay(makeParagraph(), 'x', container, { displayMode: 'original' });
    expect(h.wrapper.classList.contains('bt-pdf-translation--hidden')).toBe(true);
  });

  it('ensurePdfStyles 幂等', () => {
    ensurePdfStyles();
    ensurePdfStyles();
    expect(document.querySelectorAll('#bt-pdf-runtime-styles').length).toBe(1);
  });
});

describe('PdfTextLayerWatch：pdf.js 重排检测', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('span 数量显著变化时触发 onReflow', async () => {
    const container = document.createElement('div');
    container.className = 'textLayer';
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('span');
      s.textContent = `t${i}`;
      container.appendChild(s);
    }
    document.body.appendChild(container);

    let reflows = 0;
    const watch = new PdfTextLayerWatch(container, () => {
      reflows += 1;
    });
    watch.start();
    expect(watch.active).toBe(true);

    // 模拟 pdf.js 重建：移除大部分 span 换成新 span。
    container.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const s = document.createElement('span');
      s.textContent = `new${i}`;
      container.appendChild(s);
    }
    // MutationObserver 在 microtask 后触发，等一拍。
    await Promise.resolve();
    await Promise.resolve();
    expect(reflows).toBeGreaterThanOrEqual(1);

    watch.stop();
    expect(watch.active).toBe(false);
  });

  it('少量 span 增删不触发 reflow（容忍局部增量）', async () => {
    const container = document.createElement('div');
    for (let i = 0; i < 10; i++) {
      const s = document.createElement('span');
      s.textContent = `t${i}`;
      container.appendChild(s);
    }
    document.body.appendChild(container);
    let reflows = 0;
    const watch = new PdfTextLayerWatch(container, () => {
      reflows += 1;
    });
    watch.start();
    // 只加 1 个 span（变化量 ≤ 2，不触发）。
    container.appendChild(document.createElement('span'));
    await Promise.resolve();
    await Promise.resolve();
    expect(reflows).toBe(0);
    watch.stop();
  });
});
