import { render } from 'preact';

/**
 * Options 页（Preact 壳）。Stage 1 占位。
 * 后续实现（见 docs/ARCHITECTURE.md §2.1 / §6.2）：引擎配置 / API Key 管理（加密存储）/
 * 提示词模板 / 术语库编辑器 / 并发与分批参数 / 缓存管理。
 */
function App() {
  return (
    <main class="options">
      <h1>BatchTranslate · 设置</h1>
      <p>Options 页占位（Preact 壳）。后续在此实现引擎配置、Key 管理、术语库与并发参数。</p>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
