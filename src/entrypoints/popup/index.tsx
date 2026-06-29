import { render } from 'preact';

/**
 * Popup（Preact 壳）。Stage 1 占位。
 * 后续实现（见 docs/ARCHITECTURE.md §2.1）：当前页翻译开关 / 翻译进度 / 快速切引擎 / 模式。
 */
function App() {
  return (
    <main class="popup">
      <h1>BatchTranslate</h1>
      <p>Popup 占位（Preact 壳）。后续在此实现翻译开关、进度与引擎切换。</p>
    </main>
  );
}

const root = document.getElementById('app');
if (root) render(<App />, root);
