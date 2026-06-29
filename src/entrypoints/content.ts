import { defineContentScript } from 'wxt/utils/define-content-script';

/**
 * Content script 入口。匹配 <all_urls>，注入到每个页面。
 * Stage 1 占位：仅打印加载日志。
 *
 * 后续在此启动（见 docs/ARCHITECTURE.md §2.1 / §3 content/* 模块）：
 * - extractor：dom-walker 找可译段落 + block-classifier 分类 + text-segmenter 切分
 * - controller：content 侧编排（提取 → 发任务 → 渲染）
 * - renderer：bilingual-renderer 注入双语对照 + inline-markup 占位符保护 + layout-guard
 * - floating-ui：控制条 Preact 组件
 */
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    console.log('[BatchTranslate] content script loaded', location.href);

    // TODO(后续 issue): 启动 extractor → controller → bilingual-renderer。
  },
});
