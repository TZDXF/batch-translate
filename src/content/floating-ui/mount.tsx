/**
 * 控制条挂载：Shadow DOM 隔离样式（架构约束：scoped class bt- 或 Shadow DOM）。
 * 暴露 mountControlBar(initial, onToggle) 与 updateControlBar(patch) 供 content 控制器驱动。
 */
import { render } from 'preact';
import { ControlBar, type ControlBarState } from './control-bar';
import { CONTROL_BAR_STYLES } from './styles';

const HOST_ID = 'bt-control-host';

let hostEl: HTMLDivElement | null = null;
let rootEl: HTMLDivElement | null = null;
let current: ControlBarState = {
  on: false,
  state: 'idle',
  progress: 0,
  engineLabel: '未配置引擎',
  baseUrl: '',
  error: null,
  blocked: null,
};
let toggleHandler: () => void = () => {};

function paint(): void {
  if (rootEl) render(<ControlBar state={current} onToggle={toggleHandler} />, rootEl);
}

/** 挂载控制条（已挂载则更新 initial 并替换 onToggle）。幂等。 */
export function mountControlBar(initial: Partial<ControlBarState>, onToggle: () => void): void {
  if (hostEl) {
    current = { ...current, ...initial };
    toggleHandler = onToggle;
    paint();
    return;
  }
  hostEl = document.createElement('div');
  hostEl.id = HOST_ID;
  const shadow = hostEl.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = CONTROL_BAR_STYLES;
  shadow.appendChild(styleEl);
  rootEl = document.createElement('div');
  shadow.appendChild(rootEl);
  document.documentElement.appendChild(hostEl);

  current = { ...current, ...initial };
  toggleHandler = onToggle;
  paint();
}

/** 局部更新控制条状态并重渲染。 */
export function updateControlBar(patch: Partial<ControlBarState>): void {
  current = { ...current, ...patch };
  paint();
}

/** 仅供测试：取当前状态快照。 */
export function __getControlBarStateForTests(): ControlBarState {
  return current;
}

/** 仅供测试：卸载并重置模块级状态（测试间隔离）。 */
export function __resetControlBarForTests(): void {
  if (hostEl) hostEl.remove();
  hostEl = null;
  rootEl = null;
  current = {
    on: false,
    state: 'idle',
    progress: 0,
    engineLabel: '未配置引擎',
    baseUrl: '',
    error: null,
    blocked: null,
  };
  toggleHandler = () => {};
}
