/** 控制条样式（Shadow DOM 隔离 + bt- 前缀，架构约束）。作为字符串注入 shadow root。 */
export const CONTROL_BAR_STYLES = `
.bt-bar {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  min-width: 220px;
  max-width: 320px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #ffffff;
  color: #1f2328;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.4;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.18);
  border: 1px solid rgba(0, 0, 0, 0.08);
}
.bt-btn {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 7px;
  background: #2563eb;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.bt-btn:hover { background: #1d4ed8; }
.bt-btn.bt-off { background: #6b7280; }
.bt-btn.bt-off:hover { background: #4b5563; }
.bt-progress-wrap {
  margin-top: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bt-progress {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: #e5e7eb;
  overflow: hidden;
}
.bt-progress-fill {
  height: 100%;
  background: #2563eb;
  transition: width 0.2s ease;
}
.bt-pct { font-size: 11px; color: #6b7280; min-width: 32px; text-align: right; }
.bt-meta {
  margin-top: 8px;
  font-size: 11px;
  color: #6b7280;
  word-break: break-all;
}
.bt-meta b { color: #374151; }
.bt-error {
  margin-top: 6px;
  font-size: 11px;
  color: #b91c1c;
}
.bt-state {
  margin-top: 6px;
  font-size: 11px;
  color: #2563eb;
}
`;
