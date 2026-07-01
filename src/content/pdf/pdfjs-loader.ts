/**
 * pdf.js 加载器 —— src/content/pdf/pdfjs-loader.ts（P2-1 / TRA-24）。
 *
 * ── pdf.js 版本与 WXT 打包兼容性决策（本 issue 确认，见任务约束）──────────────
 * 依赖：`pdfjs-dist@^6`（package.json 已加）。WXT 0.20 / Vite 内置打包。
 *
 * Worker 接线方式：用 Vite 的 `?worker` 后缀把 `pdf.worker.min.mjs` 打成独立 Worker chunk，
 *   `pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker()`。
 * 理由：
 *   1. MV3 `extension_pages` CSP 为 `script-src 'self'`，`?worker` 产出的 worker chunk 落在
 *      `chrome-extension://<id>/` 自身源下，符合 CSP；不能用 blob: / 远程 workerSrc。
 *   2. `?worker` 由 Vite 统一处理，不触发 WXT 的 `wxt:download` 插件（该插件已在 wxt.config
 *      里 neutralize，仅对 `url:` 远程导入生效，pdfjs 走正常文件加载器）。
 *   3. 懒加载：本模块仅被 PDF viewer 入口动态 import，pdfjs (~1MB) 不进主 bundle。
 *
 * 回退：若环境无 Worker（如 jsdom 测试），`loadPdfjs` 抛错；PDF viewer 仅在真实浏览器运行。
 * 扫描版 PDF（无文本层）的 OCR 兜底归 P2-3，不在本 issue。
 */
import type * as PdfjsLib from 'pdfjs-dist';

// Vite `?worker`：把 pdf worker 打成独立 chunk，运行时 new 出 Worker 实例。
// @ts-expect-error -- `?worker` 后缀由 Vite 处理，无类型声明。
import PdfWorkerCtor from 'pdfjs-dist/build/pdf.worker.min.mjs?worker';

let cached: typeof PdfjsLib | null = null;
let workerArmed = false;

/**
 * 懒加载 pdf.js 主库并接好 worker。首次调用 import + 装 workerPort；后续返回缓存。
 */
export async function loadPdfjs(): Promise<typeof PdfjsLib> {
  if (cached) return cached;
  const lib = await import('pdfjs-dist');
  if (!workerArmed) {
    // GlobalWorkerOptions.workerPort 接受一个 Worker 实例；pdfjs 内部用 MessageChannel 通信。
    lib.GlobalWorkerOptions.workerPort = new PdfWorkerCtor();
    workerArmed = true;
  }
  cached = lib;
  return lib;
}

/** 重置内部缓存（测试用）。 */
export function _resetPdfjsCache(): void {
  cached = null;
  workerArmed = false;
}
