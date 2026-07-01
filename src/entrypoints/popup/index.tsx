/**
 * Popup（任务交付物 #2）：当前页翻译开关 / 进度 / 快速切引擎 / 切模式 /
 * 数据去向透明化 / 订阅 SW STATUS（架构 2.2、7.3）。
 *
 * 方案 b（TRA-22）：主密码已设置且 SW 未解锁时，先显示解锁界面；解锁后写 storage.session
 * 解锁态，SW 即可解密 API Key。未设置主密码时跳过解锁，直接进主界面（零回归）。
 */
import { useEffect, useState } from 'preact/hooks';
import { render } from 'preact';
import './popup.css';
import type { AppConfig, TabTranslationState, TranslateMode } from '../../shared/types';
import type { FromSWMessages, ToSWMessages } from '../../shared/messages';
import { isRuntimeMessage, isStatus } from '../../shared/messages';
import { activeEngine, engineLabel, loadConfig } from '../../background/config/config-store';
import {
  isMasterPasswordConfigured,
  isUnlocked,
  lock as lockVault,
  unlock as unlockVault,
  WrongPasswordError,
} from '../../background/secret/master-key';

interface TabStatus {
  state: TabTranslationState;
  progress: number;
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [status, setStatus] = useState<TabStatus>({ state: 'idle', progress: 0 });
  // null = 探测中；true = 需解锁；false = 已解锁或未设主密码。
  const [needUnlock, setNeedUnlock] = useState<boolean | null>(null);

  // 取当前激活 tab + 加载配置 + 探测解锁态。
  useEffect(() => {
    (async () => {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const id = tabs[0]?.id ?? null;
      setTabId(id);
      setConfig(await loadConfig());
      if (id != null) {
        const resp = (await chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: id } satisfies ToSWMessages)) as FromSWMessages | undefined;
        if (resp && isStatus(resp)) setStatus({ state: resp.state, progress: resp.progress });
      }
      const configured = await isMasterPasswordConfigured();
      setNeedUnlock(configured ? !(await isUnlocked()) : false);
    })().catch(() => setConfig(null));
  }, []);

  // 订阅 SW 广播的 STATUS（进度实时更新）。
  useEffect(() => {
    const listener = (msg: unknown) => {
      if (!isRuntimeMessage(msg)) return;
      if (!isStatus(msg) || msg.tabId !== tabId) return;
      setStatus({ state: msg.state, progress: msg.progress });
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, [tabId]);

  async function send(msg: ToSWMessages) {
    try {
      await chrome.runtime.sendMessage(msg);
    } catch {
      /* SW 未就绪 */
    }
  }

  if (needUnlock === null) {
    return (
      <div>
        <div class="head">
          <h1>BatchTranslate</h1>
          <div class="sub">双语对照 · 批量降并发 · 本地隐私</div>
        </div>
        <div class="section"><span class="state">加载中…</span></div>
      </div>
    );
  }

  if (needUnlock) {
    return <UnlockView onUnlocked={() => setNeedUnlock(false)} />;
  }

  function onToggle() {
    if (tabId == null) return;
    const on = !(status.state === 'translating');
    setStatus({ state: on ? 'translating' : 'idle', progress: on ? 0 : 0 });
    void send({ type: 'TOGGLE_TRANSLATE', tabId, on });
  }

  const eng = config ? activeEngine(config) : null;
  const isOn = status.state === 'translating' || status.state === 'done';
  const pct = Math.round(status.progress * 100);

  return (
    <div>
      <div class="head">
        <h1>BatchTranslate</h1>
        <div class="sub">双语对照 · 批量降并发 · 本地隐私</div>
      </div>

      <div class="section">
        <div class="row">
          <label>翻译</label>
          <div class={'toggle' + (isOn ? ' on' : '')} onClick={onToggle} role="switch" aria-checked={isOn} />
          <span class="state">{stateText(status.state)}</span>
        </div>

        {(isOn || status.state === 'paused') && (
          <div class="progress-wrap">
            <div class="progress">
              <div class="progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span class="pct">{pct}%</span>
          </div>
        )}

        {/* 数据去向透明化（架构 7.3） */}
        <div class="dest">
          正在发送至 <b>{config ? engineLabel(eng) : '…'}</b>
          {eng?.baseUrl ? ` (${eng.baseUrl})` : ''}
        </div>
      </div>

      <div class="section">
        <div class="row">
          <label>引擎</label>
          <select
            value={config?.activeEngineId ?? ''}
            onChange={(e) => { const v = e.currentTarget.value; if (v) void send({ type: 'SWITCH_ENGINE', engineId: v }); }}
          >
            {config && Object.values(config.engines).length === 0 && <option value="">未配置（去设置页添加）</option>}
            {config?.engines && Object.values(config.engines).map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </div>
        <div class="row">
          <label>模式</label>
          <select
            value={config?.mode ?? 'basic'}
            onChange={(e) => void send({ type: 'SWITCH_MODE', mode: e.currentTarget.value as TranslateMode })}
          >
            <option value="basic">基础</option>
            <option value="agent">智能体</option>
          </select>
        </div>
        <div class="row">
          <label>密钥库</label>
          <span class="state">已解锁</span>
          <button class="link-btn" onClick={async () => { await lockVault(); setNeedUnlock(true); }}>锁定</button>
        </div>
      </div>

      <a class="link" href="#" onClick={(e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}>
        打开设置页 →
      </a>
    </div>
  );
}

/** 方案 b 解锁界面：输入主密码 → 解锁写 storage.session。 */
function UnlockView({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await unlockVault(password);
      onUnlocked();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? '主密码错误' : (err instanceof Error ? err.message : '解锁失败'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div class="head">
        <h1>BatchTranslate</h1>
        <div class="sub">密钥库已锁定，输入主密码解锁</div>
      </div>
      <form class="section" onSubmit={onSubmit}>
        <div class="row">
          <label>主密码</label>
          <input
            type="password"
            autoFocus
            placeholder="输入主密码"
            value={password}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </div>
        {error && <div class="err">{error}</div>}
        <div class="row">
          <button class="primary" type="submit" disabled={!password || busy}>{busy ? '解锁中…' : '解锁'}</button>
        </div>
        <div class="dest">SW 重启后需重新解锁；主密码不落盘，仅内存派生主密钥。</div>
      </form>
      <a class="link" href="#" onClick={(e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); }}>
        打开设置页 →
      </a>
    </div>
  );
}

function stateText(state: TabTranslationState): string {
  switch (state) {
    case 'translating':
      return '翻译中…';
    case 'done':
      return '已完成';
    case 'paused':
      return '已暂停';
    case 'error':
      return '出错';
    default:
      return '关闭';
  }
}

render(<App />, document.getElementById('app')!);
