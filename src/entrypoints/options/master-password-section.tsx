/**
 * 主密码管理（架构 7.2 方案 b，TRA-22 交付物 #3）。
 *
 * 三态：
 *  - 未设置主密码：显示「设置主密码」表单（首次启用方案 b，迁移存量方案 a 密钥）。
 *  - 已设置：显示「修改主密码」（旧密码 + 新密码）+「立即锁定」。
 *
 * 设置 / 修改主密码后写 storage.session 解锁态，SW 即可解密 API Key。
 */
import { useEffect, useState } from 'preact/hooks';
import {
  changeMasterPassword,
  isMasterPasswordConfigured,
  isUnlocked,
  lock as lockVault,
  setupMasterPassword,
  unlock as unlockVault,
  WrongPasswordError,
} from '../../background/secret/master-key';

export function MasterPasswordSection() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState<boolean>(false);

  async function refresh() {
    setConfigured(await isMasterPasswordConfigured());
    setUnlocked(await isUnlocked());
  }

  useEffect(() => {
    void refresh();
  }, []);

  if (configured === null) return null;

  if (!configured) {
    return <SetupView onChanged={refresh} />;
  }

  return <ManageView unlocked={unlocked} onChanged={refresh} />;
}

/** 首次设置主密码：迁移存量方案 a 密钥到方案 b。 */
function SetupView({ onChanged }: { onChanged: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: Event) {
    e.preventDefault();
    setError(null);
    if (!password) return setError('主密码不能为空');
    if (password !== confirm) return setError('两次输入不一致');
    if (password.length < 6) return setError('主密码至少 6 位');
    setBusy(true);
    try {
      await setupMasterPassword(password);
      setPassword('');
      setConfirm('');
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : '设置失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="card">
      <h2>主密码（密钥派生）</h2>
      <p class="muted">设置主密码后，API Key 改由主密码 PBKDF2 派生主密钥加密；主密码不落盘，SW 重启需在 popup 解锁。已有 Key 会自动迁移，不丢失。</p>
      <form onSubmit={onSubmit}>
        <div class="row">
          <label>主密码</label>
          <input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} />
        </div>
        <div class="row">
          <label>确认密码</label>
          <input type="password" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </div>
        {error && <div class="muted" style={{ color: 'var(--bt-danger)' }}>{error}</div>}
        <div class="row">
          <button class="primary" type="submit" disabled={busy}>{busy ? '设置中…' : '设置主密码'}</button>
        </div>
      </form>
    </div>
  );
}

/** 已设置主密码：修改 / 锁定 / 解锁。 */
function ManageView({ unlocked, onChanged }: { unlocked: boolean; onChanged: () => Promise<void> }) {
  const [oldPw, setOldPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onChange(e: Event) {
    e.preventDefault();
    setError(null);
    if (!oldPw || !newPw) return setError('请填写旧密码与新密码');
    if (newPw !== confirm) return setError('两次新密码不一致');
    if (newPw.length < 6) return setError('新主密码至少 6 位');
    setBusy(true);
    try {
      await changeMasterPassword(oldPw, newPw);
      setOldPw('');
      setNewPw('');
      setConfirm('');
      await onChanged();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? '旧主密码错误' : (err instanceof Error ? err.message : '修改失败'));
    } finally {
      setBusy(false);
    }
  }

  async function onUnlock() {
    setError(null);
    const pw = prompt('请输入主密码以解锁密钥库');
    if (!pw) return;
    try {
      await unlockVault(pw);
      await onChanged();
    } catch (err) {
      setError(err instanceof WrongPasswordError ? '主密码错误' : (err instanceof Error ? err.message : '解锁失败'));
    }
  }

  async function onLock() {
    await lockVault();
    await onChanged();
  }

  return (
    <div class="card">
      <h2>主密码（密钥派生）</h2>
      <div class="row">
        <label>状态</label>
        <span class="muted">{unlocked ? '已解锁（内存持有派生主密钥）' : '已锁定（需在 popup 解锁后才能翻译 / 改 Key）'}</span>
        {unlocked
          ? <button onClick={onLock}>立即锁定</button>
          : <button class="primary" onClick={onUnlock}>解锁</button>}
      </div>
      <form onSubmit={onChange}>
        <div class="row">
          <label>旧主密码</label>
          <input type="password" value={oldPw} onInput={(e) => setOldPw(e.currentTarget.value)} />
        </div>
        <div class="row">
          <label>新主密码</label>
          <input type="password" value={newPw} onInput={(e) => setNewPw(e.currentTarget.value)} />
        </div>
        <div class="row">
          <label>确认新密码</label>
          <input type="password" value={confirm} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </div>
        {error && <div class="muted" style={{ color: 'var(--bt-danger)' }}>{error}</div>}
        <div class="row">
          <button class="primary" type="submit" disabled={busy}>{busy ? '修改中…' : '修改主密码'}</button>
        </div>
      </form>
    </div>
  );
}
