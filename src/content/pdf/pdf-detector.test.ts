/**
 * pdf-detector 单测（P2-1 / TRA-24）。
 */
import { describe, expect, it } from 'vitest';
import { isPdfContentType, isPdfResponse, isPdfUrl } from './pdf-detector';

describe('isPdfUrl', () => {
  it('.pdf 后缀命中', () => {
    expect(isPdfUrl('https://example.com/doc.pdf')).toBe(true);
    expect(isPdfUrl('https://example.com/path/to/file.PDF')).toBe(true);
  });
  it('带 query / hash 仍命中', () => {
    expect(isPdfUrl('https://example.com/doc.pdf?download=1')).toBe(true);
    expect(isPdfUrl('https://example.com/doc.pdf#page=3')).toBe(true);
  });
  it('非 .pdf 后缀不命中', () => {
    expect(isPdfUrl('https://example.com/doc.html')).toBe(false);
    expect(isPdfUrl('https://example.com/docpdf')).toBe(false);
  });
  it('空 / 非法 URL 不命中', () => {
    expect(isPdfUrl('')).toBe(false);
  });
});

describe('isPdfContentType', () => {
  it('application/pdf 命中', () => {
    expect(isPdfContentType('application/pdf')).toBe(true);
    expect(isPdfContentType('application/pdf; charset=utf-8')).toBe(true);
    expect(isPdfContentType('  APPLICATION/PDF ')).toBe(true);
  });
  it('非 PDF 类型不命中', () => {
    expect(isPdfContentType('text/html')).toBe(false);
    expect(isPdfContentType('application/octet-stream')).toBe(false);
    expect(isPdfContentType('')).toBe(false);
  });
});

describe('isPdfResponse', () => {
  it('URL 命中即 true', () => {
    expect(isPdfResponse('https://example.com/a.pdf', 'text/html')).toBe(true);
  });
  it('Content-Type 命中即 true', () => {
    expect(isPdfResponse('https://example.com/a', 'application/pdf')).toBe(true);
  });
  it('两者都不命中 → false', () => {
    expect(isPdfResponse('https://example.com/a.html', 'text/html')).toBe(false);
  });
});
