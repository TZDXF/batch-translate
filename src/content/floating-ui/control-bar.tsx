/** 页面内悬浮控制条（Preact）。开关 / 进度 / 数据去向透明化 / 错误提示（任务交付物 #3）。 */
import type { TabTranslationState } from '../../shared/types';

export interface ControlBarState {
  on: boolean;
  state: TabTranslationState;
  /** 0..1。 */
  progress: number;
  engineLabel: string;
  baseUrl: string;
  error: string | null;
  /** 域名策略禁用翻译（P1-3）：非空时禁用开关并展示原因。 */
  blocked: string | null;
}

interface ControlBarProps {
  state: ControlBarState;
  onToggle: () => void;
}

const STATE_TEXT: Record<TabTranslationState, string> = {
  idle: '',
  translating: '翻译中…',
  done: '翻译完成',
  paused: '已暂停',
  error: '出错',
};

export function ControlBar({ state, onToggle }: ControlBarProps) {
  const pct = Math.round(state.progress * 100);
  const showProgress = state.on && (state.state === 'translating' || state.state === 'done');
  const blocked = !!state.blocked;
  const btnClass = state.on ? 'bt-btn bt-off' : 'bt-btn';

  return (
    <div class="bt-bar">
      <button class={btnClass} onClick={onToggle} disabled={blocked}>
        {state.on ? '■ 停止翻译' : '▶ 翻译本页'}
      </button>

      {blocked && <div class="bt-blocked">{state.blocked}</div>}

      {showProgress && (
        <div class="bt-progress-wrap">
          <div class="bt-progress">
            <div class="bt-progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span class="bt-pct">{pct}%</span>
        </div>
      )}

      {state.state !== 'idle' && <div class="bt-state">{STATE_TEXT[state.state]}</div>}

      {/* 数据去向透明化（架构 7.3）：明示译文正发往哪个引擎 / endpoint */}
      <div class="bt-meta">
        正在发送至 <b>{state.engineLabel || '未配置引擎'}</b>
        {state.baseUrl ? ` (${state.baseUrl})` : ''}
      </div>

      {state.error && <div class="bt-error">{state.error}</div>}
    </div>
  );
}
