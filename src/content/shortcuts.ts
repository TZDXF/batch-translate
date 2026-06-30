/**
 * 快捷键映射 —— 纯函数（P1-3，架构 P1 路线图）。
 *
 * 加速器字符串规范（与 Chrome 扩展 commands JSON 一致，便于用户认知）：
 *   "Ctrl+Shift+T"、"Alt+Shift+D"、"Mod+R"（Mod = Ctrl on Win/Linux, Cmd on Mac）
 * 修饰键顺序固定：Ctrl → Alt → Shift → Meta（或 Mod），主键大写。
 * 仅支持单主键（字母/数字）；不支持 MediaPlay 等特殊键（本扩展用不上）。
 *
 * 纯函数：parseAccelerator / eventToAccelerator / normalizeAccelerator / detectConflicts。
 * 无 DOM 依赖（eventToAccelerator 接受 KeyboardEvent-like 对象，便于 jsdom 注入）。
 */
import type { ShortcutAction, Shortcuts } from '../shared/types';

const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta']);

/** 排序后的修饰键顺序（Mod 占 Ctrl 位）。 */
const MODIFIER_ORDER = ['Ctrl', 'Mod', 'Alt', 'Shift', 'Meta'];

/** 是否为合法主键（单个字符 / 字母 / 数字）。 */
function isMainKey(key: string): boolean {
  if (!key || key.length !== 1) return false;
  // 字母或数字
  return /^[a-z0-9]$/i.test(key);
}

/** 把加速器字符串归一化为标准形式（修饰键排序 + 主键大写）。非法 → null。 */
export function normalizeAccelerator(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return null;

  const modifiers = new Set<string>();
  let mainKey = '';
  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'mod') modifiers.add('Mod');
    else if (p === 'ctrl' || p === 'control') {
      // Mod 与 Ctrl 互斥：统一以 Ctrl 记（除非原串用 Mod）。
      modifiers.add('Ctrl');
    } else if (p === 'alt') modifiers.add('Alt');
    else if (p === 'shift') modifiers.add('Shift');
    else if (p === 'meta' || p === 'cmd' || p === 'command') modifiers.add('Meta');
    else {
      // 主键只允许出现一次。
      if (mainKey) return null;
      if (!isMainKey(part)) return null;
      mainKey = part.toUpperCase();
    }
  }
  if (!mainKey) return null;

  const orderedMods = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  // Mod 与 Ctrl 互斥：若同时出现视为非法（用户不应混用）。
  if (orderedMods.includes('Mod') && orderedMods.includes('Ctrl')) return null;
  return [...orderedMods, mainKey].join('+');
}

/** 解析加速器字符串为标准形式；非法返回 null（normalizeAccelerator 别名，语义清晰）。 */
export function parseAccelerator(input: string): string | null {
  return normalizeAccelerator(input);
}

/**
 * 从 KeyboardEvent 构造加速器字符串。
 * 接受结构化对象（key / altKey / ctrlKey / shiftKey / metaKey），便于 jsdom 与真实事件共用。
 * 修饰键按下但主键为修饰键本身时返回 null（不把纯修饰键按压视为完整快捷键）。
 */
export function eventToAccelerator(e: {
  key: string;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  metaKey?: boolean;
}): string | null {
  const key = e.key ?? '';
  // 忽略修饰键本身的按压。
  if (MODIFIER_KEYS.has(key)) return null;
  if (!isMainKey(key)) return null;
  const mods: string[] = [];
  // 浏览器原生事件无 Mod 概念，这里统一输出 Ctrl/Meta（与用户在 options 填的 Ctrl/Meta 对应）。
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Meta');
  return [...mods, key.toUpperCase()].join('+');
}

/** 两个加速器是否等价（归一化后比较）。 */
export function acceleratorsEqual(a: string, b: string): boolean {
  const na = normalizeAccelerator(a);
  const nb = normalizeAccelerator(b);
  return na !== null && na === nb;
}

/**
 * 冲突检测：找出映射中互相冲突的动作对（同一加速器被多个动作占用）。
 * 仅对合法加速器检测；非法条目不参与冲突（options 页单独提示非法）。
 *
 * @returns 冲突数组：{ actions: [a1, a2], accelerator }。
 */
export function detectConflicts(
  shortcuts: Shortcuts,
): Array<{ actions: [ShortcutAction, ShortcutAction]; accelerator: string }> {
  const normalized = new Map<string, ShortcutAction[]>();
  (Object.keys(shortcuts) as ShortcutAction[]).forEach((action) => {
    const acc = normalizeAccelerator(shortcuts[action]);
    if (!acc) return;
    const list = normalized.get(acc) ?? [];
    list.push(action);
    normalized.set(acc, list);
  });
  const conflicts: Array<{ actions: [ShortcutAction, ShortcutAction]; accelerator: string }> = [];
  for (const [acc, actions] of normalized) {
    if (actions.length < 2) continue;
    // 同一加速器被 N 个动作占用：两两记录（N 通常为 2）。
    for (let i = 0; i < actions.length; i++) {
      for (let j = i + 1; j < actions.length; j++) {
        conflicts.push({ actions: [actions[i]!, actions[j]!], accelerator: acc });
      }
    }
  }
  return conflicts;
}

/** 检测某动作的快捷键是否合法且不与其余动作冲突。 */
export function validateShortcut(
  action: ShortcutAction,
  shortcuts: Shortcuts,
): { ok: true } | { ok: false; reason: 'invalid' | 'conflict'; conflictWith?: ShortcutAction } {
  const acc = normalizeAccelerator(shortcuts[action]);
  if (!acc) return { ok: false, reason: 'invalid' };
  for (const other of Object.keys(shortcuts) as ShortcutAction[]) {
    if (other === action) continue;
    const otherAcc = normalizeAccelerator(shortcuts[other]);
    if (otherAcc && otherAcc === acc) {
      return { ok: false, reason: 'conflict', conflictWith: other };
    }
  }
  return { ok: true };
}
