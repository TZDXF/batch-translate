/**
 * PDF 检测 —— src/content/pdf/pdf-detector.ts（P2-1 / TRA-24）。
 *
 * 纯函数：判定给定 URL / Content-Type 是否为 PDF 响应，供 PDF 入口（content script /
 * 独立 PDF 页面）决定是否注入 pdf.js viewer + 翻译层。见 docs/ARCHITECTURE.md 第 8 节。
 *
 * 判据（任一命中即视为 PDF）：
 *  1. URL 路径以 `.pdf` 结尾（忽略 query/hash，大小写不敏感）；
 *  2. Content-Type 为 `application/pdf`（含带参数如 `; charset=...`，宽松匹配）。
 */
/** URL 是否指向 PDF（按路径后缀，忽略 query/hash，大小写不敏感）。 */
export function isPdfUrl(url: string): boolean {
  if (!url) return false;
  // 去掉 query / hash 后取路径。
  const path = url.split('#', 1)[0]?.split('?', 1)[0] ?? '';
  return /\.pdf$/i.test(path);
}

/** Content-Type 是否为 PDF（宽松匹配 application/pdf，忽略参数与大小写）。 */
export function isPdfContentType(contentType: string): boolean {
  if (!contentType) return false;
  return /^application\/pdf\b/i.test(contentType.trim());
}

/** 综合判定：URL 或 Content-Type 任一命中即视为 PDF。 */
export function isPdfResponse(url: string, contentType: string): boolean {
  return isPdfUrl(url) || isPdfContentType(contentType);
}
