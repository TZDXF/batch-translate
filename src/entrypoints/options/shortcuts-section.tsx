/** 快捷键自定义（P1-3）：开关 / 循环显示模式 / 重译当前段，含冲突检测。 */
import { useState } from 'preact/hooks';
import type { AppConfig, ShortcutAction, Shortcuts } from '../../shared/types';
import { DEFAULT_SHORTCUTS } from '../../shared/constants';
import { patchConfig } from '../../background/config/config-store';
import { normalizeAccelerator, validateShortcut } from '../../content/shortcuts';

const ACTION_LABELS: Record<ShortcutAction, string> = {
  toggle: '开关翻译',
  cycleDisplayMode: '切换显示模式',
  retranslate: '重译当前段',
};

export function ShortcutsSection({ config }: { config: AppConfig }) {
  const [draft, setDraft] = useState<Shortcuts>({ ...config.shortcuts });
  const [capturing, setCapturing] = useState<ShortcutAction | null>(null);

  const save = (next: Shortcuts) => {
    setDraft(next);
    void patchConfig({ shortcuts: next });
  };

  const onCaptureKey = (action: ShortcutAction, e: KeyboardEvent) => {
    e.preventDefault();
    // 仅在按下非修饰主键时落定；Esc 取消。
    if (e.key === 'Escape') {
      setCapturing(null);
      return;
    }
    const mods = ['Control', 'Alt', 'Shift', 'Meta'];
    if (mods.includes(e.key)) return; // 等待主键
    const parts: string[] = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    if (/^[a-zA-Z0-9]$/.test(e.key)) {
      parts.push(e.key.toUpperCase());
      save({ ...draft, [action]: parts.join('+') });
      setCapturing(null);
    }
  };

  return (
    <div class="card">
      <h2>快捷键</h2>
      <p class="muted">点击输入框并按下组合键录制；至少包含一个修饰键 + 字母/数字。默认 Alt+Shift+T/D/R。</p>
      {(Object.keys(ACTION_LABELS) as ShortcutAction[]).map((action) => {
        const v = draft[action];
        const norm = normalizeAccelerator(v);
        const valid = validateShortcut(action, draft);
        return (
          <div class="row" key={action}>
            <label>{ACTION_LABELS[action]}</label>
            <input
              type="text"
              value={capturing === action ? '按下组合键…（Esc 取消）' : v}
              onFocus={() => setCapturing(action)}
              onKeyDown={(e) => capturing === action && onCaptureKey(action, e as unknown as KeyboardEvent)}
              onBlur={() => setCapturing(null)}
              style="max-width:220px;"
              readonly={capturing === action}
            />
            {!norm && <span class="muted" style="color:var(--bt-danger);">格式非法</span>}
            {valid.ok === false && valid.reason === 'conflict' && (
              <span class="muted" style="color:var(--bt-danger);">与「{ACTION_LABELS[valid.conflictWith!]}」冲突</span>
            )}
            <button onClick={() => save({ ...draft, [action]: DEFAULT_SHORTCUTS[action] })}>重置</button>
          </div>
        );
      })}
    </div>
  );
}
