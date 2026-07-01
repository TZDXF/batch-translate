/**
 * PDF 翻译独立页入口（P2-1 / TRA-24，架构第 8 节）。
 *
 * WXT unlisted page：用户以 `chrome-extension://<id>/pdf-viewer.html?url=<pdf-url>` 打开，
 * 本页拉取 PDF → pdf.js 渲染 → 文本层提取 → 复用翻译 Port 主通道 → 译文 overlay 叠加。
 *
 * 之所以用独立页而非 content script 注入：Chrome 对 `application/pdf` 响应启用内置 PDF
 * 查看器，content script 不会在其内运行；独立扩展页是架构第 8 节允许的入口形态
 * （「注入 pdf.js viewer + 翻译层，或独立 PDF 页面」）。自动把 PDF 响应重定向到本页
 * 可后续用 declarativeNetRequest 实现，不在本 issue 范围。
 *
 * CSP：本页为 `extension_pages`，`script-src 'self'`；pdf.js worker 经 Vite `?worker` 打成
 * self 源 chunk，符合 CSP（见 pdfjs-loader.ts 决策）。
 */
import { createPdfjsRenderer, isPdfTranslating, startPdfTranslation, stopPdfTranslation } from '../../content/pdf/pdf-controller';
import { isPdfUrl } from '../../content/pdf/pdf-detector';

const viewer = document.getElementById('bt-pdf-viewer') as HTMLDivElement;
const toggleBtn = document.getElementById('bt-pdf-toggle') as HTMLButtonElement;
const statusEl = document.getElementById('bt-pdf-status') as HTMLSpanElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

/** 从查询参数取 PDF 来源 URL。 */
function getPdfSourceUrl(): string | null {
  const params = new URLSearchParams(location.search);
  const url = params.get('url') ?? params.get('file');
  return url && isPdfUrl(url) ? url : url; // 允许非 .pdf URL（某些 PDF 无后缀），交由 fetch 判定
}

async function fetchPdfArrayBuffer(url: string): Promise<ArrayBuffer> {
  // 同源 / 扩展页 fetch：受 host_permissions 约束。用户填的 PDF URL 需对应 host 权限。
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`加载 PDF 失败：HTTP ${resp.status}`);
  return resp.arrayBuffer();
}

async function main(): Promise<void> {
  const url = getPdfSourceUrl();
  if (!url) {
    setStatus('请在 URL 后附加 ?url=<PDF 地址>');
    return;
  }
  setStatus('加载 PDF…');
  let data: ArrayBuffer;
  try {
    data = await fetchPdfArrayBuffer(url);
  } catch (e) {
    setStatus(`加载失败：${(e as Error).message}`);
    return;
  }

  let renderer;
  try {
    renderer = await createPdfjsRenderer(data);
  } catch (e) {
    setStatus(`pdf.js 渲染失败：${(e as Error).message}`);
    return;
  }

  toggleBtn.addEventListener('click', async () => {
    if (isPdfTranslating()) {
      stopPdfTranslation();
      toggleBtn.textContent = '开启翻译';
      setStatus('已停止');
      return;
    }
    toggleBtn.textContent = '停止翻译';
    setStatus('翻译中…');
    try {
      await startPdfTranslation(viewer, renderer);
      setStatus(isPdfTranslating() ? '翻译中…' : '完成');
    } catch (e) {
      setStatus(`翻译失败：${(e as Error).message}`);
      toggleBtn.textContent = '开启翻译';
    }
  });

  setStatus(`PDF 已加载（共 ${renderer.numPages} 页），点击「开启翻译」`);
}

void main();
