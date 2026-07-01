/**
 * 引擎流式适配（P1-2 / TRA-17，架构 2.2 / 4.6 / 9）。
 *
 * 三块职责：
 *
 * 1. **StreamingBatchParser** —— 增量 JSON 解析器。批量协议（架构 4.2）的响应是
 *    `{"items":[{"id":"1","text":"..."},{"id":"2","text":"..."}]}`。流式时引擎逐 delta
 *    吐出该 JSON 的片段，本解析器喂一段、吐一段，**按 id 对齐还原**每个 item 的 text
 *    增量（架构要求「按 P0-4 批量协议 id 对齐还原」）。解析器是纯函数态、可单测：
 *    不发请求、不碰 DOM，输入是 delta 字符串，输出是 `{id, delta}[]`。
 *
 * 2. **openAIStreamDeltas** —— OpenAI 兼容 SSE 流式 fetch（原生 fetch，不引 SDK，架构 1）。
 *    `POST /chat/completions` + `stream:true`，解析 `data: {...}` 行，拼接
 *    `choices[0].delta.content`。AbortSignal 透传，CANCEL 即中止（架构 5.2 AbortError 直抛）。
 *
 * 3. **StreamingEngine 适配** —— 把 OpenAIEngine 等支持流式的引擎统一成
 *    `translateStream(req): AsyncIterable<EngineStreamEvent>`，供 orchestrator 消费。
 *    非 OpenAI 兼容引擎（Claude/Gemini/Ollama）暂未实现流式 → orchestrator 检测到
 *    `translateStream` 缺失即回退非流式整批（架构 4.6 容错复用）。
 *
 * ── 契约边界 ──────────────────────────────────────────────────────────────
 * 不改 adapter.ts 既有 `Engine.translate` 契约（约束：引擎适配层接口变更先在 issue 讨论）。
 * 本文件新增的 `StreamingEngine` 是**可选扩展接口**，引擎按需实现，orchestrator 用
 * `isStreamingEngine()` 探测，未实现即回退 —— 既有引擎与测试零回归。
 */
import type { TranslateRequest } from './adapter';
import { EngineRequestError } from './adapter';

// ═══════════════════════════════════════════════════════════════════════════
// 1. StreamingBatchParser —— 增量 JSON items 解析
// ═══════════════════════════════════════════════════════════════════════════

/** 单个 item 的增量 delta（按 id 对齐）。 */
export interface StreamItemDelta {
  id: string;
  /** 自上次该 id 已发射的 text 后的新增片段。 */
  delta: string;
}

/**
 * 增量批量协议 JSON 解析器。
 *
 * 工作方式：每次 `feed(delta)` 把新片段追加到内部 buffer，然后重新扫描 buffer：
 *  - 找到 `"items"` 数组起点 `[`。
 *  - 逐个扫描 item 对象（字符串/转义感知），完整闭合的进 `complete`，未闭合的为 `partial`。
 *  - 维护 `emittedText: Map<id, string>`（已发射的 text 累计），对 complete 项发射
 *    `finalText - emitted` 的尾增量，对 partial 项发射 `partialText - emitted` 的新增量。
 *
 * 这样无论 delta 在 JSON 哪个位置切断，都能稳定按 id 还原增量，且最终 finalize 与
 * protocol.parseResponse 同源（喂完整 buffer 即等价整批解析）。
 *
 * 幂等可续传（架构 9）：解析器无外部副作用，SW 卸载重启后重新喂同一段 buffer 产出相同
 * delta 序列；orchestrator 侧靠 batchId/paragraphId 幂等，重复段不会重显（renderer setText）。
 */
export class StreamingBatchParser {
  private buffer = '';
  /** id → 已发射的 text 累计长度（按字符）。 */
  private readonly emittedText = new Map<string, string>();
  /** 已作为 complete 处理的 item 数量（避免重复处理已闭合项）。 */
  private completedCount = 0;

  /** 喂入一段 delta，返回自上次以来新增的 per-id delta（顺序按出现顺序）。 */
  feed(delta: string): StreamItemDelta[] {
    if (!delta) return [];
    this.buffer += delta;
    const scan = scanItems(this.buffer);
    const out: StreamItemDelta[] = [];

    // 1. 处理新完成的 item（含「上次是 partial、本次闭合」的那一个）。
    for (let i = this.completedCount; i < scan.complete.length; i++) {
      const item = scan.complete[i]!;
      const prev = this.emittedText.get(item.id) ?? '';
      // finalText 可能比 prev 短（理论上不会，但容错：取大者方向只发新增）。
      const next = item.text.length >= prev.length ? item.text : prev;
      const deltaText = next.length > prev.length ? next.slice(prev.length) : '';
      if (deltaText) out.push({ id: item.id, delta: deltaText });
      this.emittedText.set(item.id, next);
    }
    this.completedCount = scan.complete.length;

    // 2. 处理当前 partial item（未闭合，text 仍在增长）。
    if (scan.partial && scan.partial.id !== null) {
      const id = scan.partial.id;
      const prev = this.emittedText.get(id) ?? '';
      const cur = scan.partial.text;
      if (cur.length > prev.length) {
        out.push({ id, delta: cur.slice(prev.length) });
        this.emittedText.set(id, cur);
      } else if (cur.length < prev.length) {
        // partial 文本回缩（罕见，如转义边界修正）：以 cur 为准重发差额。
        // 简单起见不回退已发射字符，仅同步 emitted 基线，避免后续重复发射。
        this.emittedText.set(id, cur);
      }
    }
    return out;
  }

  /** 累计的完整原文（用于流结束后交给 protocol.parseResponse 对齐/降级，复用 P0-4 容错）。 */
  finalContent(): string {
    return this.buffer;
  }

  /** 重置（复用实例处理下一批）。 */
  reset(): void {
    this.buffer = '';
    this.emittedText.clear();
    this.completedCount = 0;
  }
}

/** scanItems 产出的 item。 */
interface ScannedItem {
  id: string;
  text: string;
}

/** 扫描 buffer 得出已闭合 item 列表 + 当前未闭合 item（若有）。 */
interface ScanResult {
  complete: ScannedItem[];
  partial: { id: string | null; text: string } | null;
}

/**
 * 扫描 buffer 中的 items 数组。
 * 找不到 `"items"` 数组起点时返回空（仍在流前缀阶段，如引擎先吐思考文本）。
 */
function scanItems(buffer: string): ScanResult {
  const arrStart = findItemsArrayStart(buffer);
  if (arrStart < 0) return { complete: [], partial: null };

  const complete: ScannedItem[] = [];
  let partial: { id: string | null; text: string } | null = null;

  let i = arrStart; // 指向 `[` 之后第一个字符
  while (true) {
    // 跳过空白与分隔符。
    while (i < buffer.length && (buffer[i] === ' ' || buffer[i] === '\n' || buffer[i] === '\r' || buffer[i] === '\t' || buffer[i] === ',')) i++;
    if (i >= buffer.length) break;
    if (buffer[i] === ']') { partial = null; break; } // 数组闭合，无 partial
    if (buffer[i] !== '{') { i++; continue; } // 容错跳过未知字符

    const obj = scanObject(buffer, i);
    if (obj.end === undefined) {
      // 未闭合对象 → partial（id 可能已读到，text 可能部分）。
      partial = { id: obj.id ?? null, text: obj.text ?? '' };
      break;
    }
    // 闭合对象。id/text 缺失时跳过（容错：非标准项）。
    if (obj.id !== undefined && obj.text !== undefined) {
      complete.push({ id: obj.id, text: obj.text });
    }
    i = obj.end + 1;
  }
  return { complete, partial };
}

/**
 * 定位 `"items"` 数组起始 `[` 的下一个字符索引。找不到返回 -1。
 * 仅在顶层查找第一个 `"items"` 键（字符串感知，避免误匹配字符串内的 items）。
 */
function findItemsArrayStart(buffer: string): number {
  let i = 0;
  let inStr = false;
  let escaped = false;
  while (i < buffer.length) {
    const ch = buffer[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      // 检查是否为 "items" 键。
      if (buffer.startsWith('items', i + 1) && buffer[i + 6] === '"') {
        // 跳过 "items"，找随后的 ':' 与 '['
        let j = i + 7;
        while (j < buffer.length && (buffer[j] === ' ' || buffer[j] === '\n' || buffer[j] === '\r' || buffer[j] === '\t')) j++;
        if (buffer[j] === ':') {
          j++;
          while (j < buffer.length && (buffer[j] === ' ' || buffer[j] === '\n' || buffer[j] === '\r' || buffer[j] === '\t')) j++;
          if (buffer[j] === '[') return j + 1;
        }
      }
      inStr = true;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

/**
 * 扫描一个对象（start 指向 `{`）。
 * - 闭合：返回 end（`}` 索引）+ JSON.parse 得到的 id/text。
 * - 未闭合：end=undefined，返回已提取的 id/text（text 可能是部分字符串值）。
 */
function scanObject(buffer: string, start: number): {
  end: number | undefined;
  id: string | undefined;
  text: string | undefined;
} {
  // 先尝试找到闭合 `}`：字符串/转义感知的深度匹配。
  let i = start + 1;
  let inStr = false;
  let escaped = false;
  while (i < buffer.length) {
    const ch = buffer[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') { inStr = true; i++; continue; }
    if (ch === '{') { i++; continue; }
    if (ch === '}') {
      // 闭合。JSON.parse 整个对象子串。
      const objStr = buffer.slice(start, i + 1);
      const parsed = tryParseObject(objStr);
      if (parsed) {
        return { end: i, id: parsed.id, text: parsed.text };
      }
      // parse 失败（如内嵌非法字符）：仍当作闭合，尽力提取字段。
      const fields = extractFieldsPartial(buffer, start, i + 1);
      return { end: i, id: fields.id, text: fields.text };
    }
    i++;
  }
  // 未闭合：提取已出现的 id/text 字段（text 可能是部分字符串值）。
  const fields = extractFieldsPartial(buffer, start, buffer.length);
  return { end: undefined, id: fields.id, text: fields.text };
}

function tryParseObject(s: string): { id?: string; text?: string } | null {
  try {
    const o = JSON.parse(s) as Record<string, unknown>;
    const id = typeof o['id'] === 'string' || typeof o['id'] === 'number' ? String(o['id']) : undefined;
    const text = typeof o['text'] === 'string' ? o['text'] : undefined;
    return { ...(id !== undefined ? { id } : {}), ...(text !== undefined ? { text } : {}) };
  } catch {
    return null;
  }
}

/**
 * 从 buffer 的 [start, end) 区间提取 `"id"` 与 `"text"` 字段值（容错部分字符串）。
 * 用于未闭合对象 / parse 失败的对象。text 值可能未闭合 → 取到区间末尾并尽力反转义。
 */
function extractFieldsPartial(buffer: string, start: number, end: number): { id: string | undefined; text: string | undefined } {
  let id: string | undefined;
  let text: string | undefined;
  let i = start + 1;
  let inStr = false;
  let escaped = false;
  // 先找键，键是字符串后跟 ':'。
  while (i < end) {
    const ch = buffer[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      i++;
      continue;
    }
    if (ch === '"') {
      // 读取键名。
      const keyEnd = findStringEnd(buffer, i);
      if (keyEnd === -1) break; // 键本身未闭合，无法继续。
      const key = tryParseString(buffer.slice(i, keyEnd + 1));
      i = keyEnd + 1;
      // 跳过空白找 ':'。
      while (i < end && (buffer[i] === ' ' || buffer[i] === '\n' || buffer[i] === '\r' || buffer[i] === '\t')) i++;
      if (buffer[i] !== ':') continue;
      i++;
      while (i < end && (buffer[i] === ' ' || buffer[i] === '\n' || buffer[i] === '\r' || buffer[i] === '\t')) i++;
      if (buffer[i] !== '"') {
        // 非字符串值（数字等）——跳过到逗号或末尾。
        while (i < end && buffer[i] !== ',' && buffer[i] !== '}') i++;
        continue;
      }
      // 字符串值：找闭合引号；未闭合则取到 end 尽力反转义。
      const valStart = i + 1;
      const valEnd = findStringEnd(buffer, i);
      if (valEnd === -1) {
        // 未闭合字符串值（流式尾部）。
        const raw = buffer.slice(valStart, end);
        const decoded = decodePartialString(raw);
        if (key === 'id' && id === undefined) id = decoded;
        else if (key === 'text' && text === undefined) text = decoded;
        break; // 已到 buffer 末尾
      } else {
        const decoded = tryParseString(buffer.slice(i, valEnd + 1)) ?? '';
        if (key === 'id' && id === undefined) id = decoded;
        else if (key === 'text' && text === undefined) text = decoded;
        i = valEnd + 1;
      }
      continue;
    }
    i++;
  }
  return { id, text };
}

/** 找到 start 处开头的字符串的闭合引号索引（转义感知）。未闭合返回 -1。 */
function findStringEnd(buffer: string, start: number): number {
  let i = start + 1;
  let escaped = false;
  while (i < buffer.length) {
    const ch = buffer[i]!;
    if (escaped) { escaped = false; i++; continue; }
    if (ch === '\\') { escaped = true; i++; continue; }
    if (ch === '"') return i;
    i++;
  }
  return -1;
}

/** JSON.parse 一个完整字符串字面量（含引号）；失败返回 null。 */
function tryParseString(literal: string): string | null {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return null;
  }
}

/**
 * 尽力反转义一段未闭合的字符串内部文本（流式尾部可能切断转义序列）。
 * 策略：尾部奇数个反斜杠 = 有未配对 escape 起始 → 裁掉最后一个；再裁尾部不完整的
 * `\uXXXX`；然后补闭合引号 JSON.parse；仍失败则原样返回。
 */
function decodePartialString(rawInner: string): string {
  let s = rawInner;
  // 尾部反斜杠奇偶性：奇数 = 最后一个 \ 是未完成 escape 的起始 → 裁掉。
  let trailing = 0;
  while (trailing < s.length && s[s.length - 1 - trailing] === '\\') trailing++;
  if (trailing % 2 === 1) s = s.slice(0, -1);

  try {
    return JSON.parse('"' + s + '"') as string;
  } catch {
    // fall through to \u trim
  }
  // 尾部不完整的 `\uXXXX`：裁到最后一个未完成的 `\u` 之前。
  const uMatch = s.match(/\\u[0-9a-fA-F]{0,3}$/);
  if (uMatch) {
    const trimmed = s.slice(0, s.length - uMatch[0].length);
    try {
      return JSON.parse('"' + trimmed + '"') as string;
    } catch {
      return rawInner;
    }
  }
  // 兜底：原样返回内部文本（占位符 `[[n]]` 不含转义，多数场景不受影响）。
  return rawInner;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. OpenAI 兼容 SSE 流式 fetch
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 发起 OpenAI 兼容流式请求，逐 delta yield `choices[0].delta.content`。
 *
 * @param url `${baseUrl}/chat/completions`
 * @param headers 鉴权头（与 OpenAIEngine.headers 同构）
 * @param body 已序列化的请求体（含 `stream:true`）
 * @param signal 中止信号（CANCEL 透传，AbortError 直抛）
 */
export async function* openAIStreamDeltas(
  url: string,
  headers: Record<string, string>,
  body: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, unknown> {
  let resp: Response;
  try {
    resp = await fetch(url, { method: 'POST', headers, body, signal });
  } catch (err) {
    if (isAbortError(err)) throw err;
    throw new EngineRequestError(
      `流式网络请求失败: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  }

  if (!resp.ok) {
    const detail = await safeReadError(resp).catch(() => '');
    throw new EngineRequestError(`OpenAI 兼容流式请求失败 ${resp.status}: ${detail}`, resp.status);
  }
  if (!resp.body) {
    // 无 body（不应发生）→ 视为空流，由上层走非流式回退。
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuffer += decoder.decode(value, { stream: true });
      // SSE 事件以空行（\n\n 或 \r\n\r\n）分隔。
      let sep = findSseBoundary(sseBuffer);
      while (sep !== -1) {
        const eventText = sseBuffer.slice(0, sep.idx);
        sseBuffer = sseBuffer.slice(sep.idx + sep.len);
        const delta = parseOpenAIDelta(eventText);
        if (delta) yield delta;
        sep = findSseBoundary(sseBuffer);
      }
    }
    // flush 尾部残余事件。
    if (sseBuffer.trim()) {
      const delta = parseOpenAIDelta(sseBuffer);
      if (delta) yield delta;
    }
  } finally {
    // reader 中止/完成均释放锁，避免 stream lock 泄漏（SW 卸载前释放）。
    try {
      reader.releaseLock();
    } catch {
      /* 已释放 / 已错误 */
    }
  }
}

/** SSE 事件分隔符定位：返回 {idx, len} 或 -1。 */
function findSseBoundary(s: string): { idx: number; len: number } | -1 {
  const i1 = s.indexOf('\n\n');
  const i2 = s.indexOf('\r\n\r\n');
  if (i1 < 0 && i2 < 0) return -1;
  if (i2 >= 0 && (i1 < 0 || i2 < i1)) return { idx: i2, len: 4 };
  return { idx: i1, len: 2 };
}

/**
 * 解析一个 SSE 事件块为 delta.content。
 * 仅取 `data:` 行；`[DONE]` 结束；其余 JSON 解析后取 choices[0].delta.content。
 */
function parseOpenAIDelta(eventText: string): string | null {
  const lines = eventText.split(/\r?\n/);
  const dataLines = lines
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart());
  if (dataLines.length === 0) return null;
  const data = dataLines.join('\n');
  if (data === '[DONE]') return null;
  try {
    const obj = JSON.parse(data) as {
      choices?: Array<{ delta?: { content?: string } }>;
    };
    const content = obj.choices?.[0]?.delta?.content;
    return typeof content === 'string' ? content : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. StreamingEngine 统一接口
// ═══════════════════════════════════════════════════════════════════════════

/** 引擎流式事件：delta 增量原文（可能跨多个 item，由上层 StreamingBatchParser 拆分）。 */
export type EngineStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done'; content: string };

/**
 * 可流式引擎可选接口。orchestrator 用 `isStreamingEngine()` 探测；
 * 未实现时回退非流式整批（架构 4.6 容错）。
 *
 * 契约：yield 0..N 个 `delta`（增量原文），最后 yield 一个 `done`（完整原文）。
 * 中止时抛 AbortError（不可重试，架构 5.2）。
 */
export interface StreamingEngine {
  translateStream(req: TranslateRequest): AsyncIterable<EngineStreamEvent>;
}

/** 引擎是否支持流式。 */
export function isStreamingEngine(engine: unknown): engine is StreamingEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as { translateStream?: unknown }).translateStream === 'function'
  );
}

/**
 * 把 StreamingEngine 的原始 delta 流拆成 per-id 增量（按批量协议 id 对齐）。
 * 供 orchestrator 流式路径消费：每个 delta 喂 parser，parser 吐 {id,delta}[]。
 * 流结束（done）时返回完整原文，交给 protocol.parseResponse 走对齐/降级/缓存。
 *
 * @returns 完整原文（done.content）
 * @throws 引擎抛出的错（AbortError / EngineRequestError）原样上抛
 */
export async function consumeStreamById(
  engine: StreamingEngine,
  req: TranslateRequest,
  parser: StreamingBatchParser,
  onDelta: (id: string, delta: string) => void,
): Promise<string> {
  let full = '';
  for await (const ev of engine.translateStream(req)) {
    if (ev.type === 'delta') {
      full += ev.content;
      const deltas = parser.feed(ev.content);
      for (const d of deltas) onDelta(d.id, d.delta);
    } else {
      // done：以引擎最终完整原文为准（修正流式拼接的转义边界误差）。
      full = ev.content;
      // done 后再喂一次确保 parser 同步到完整（done.content 应与累计一致）。
      parser.feed(ev.content);
    }
  }
  return full;
}

// ═══════════════════════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════════════════════

function isAbortError(err: unknown): boolean {
  if (err instanceof DOMException) return err.name === 'AbortError';
  return err instanceof Error && err.name === 'AbortError';
}

async function safeReadError(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    try {
      const obj = JSON.parse(text) as { error?: { message?: string } };
      return obj.error?.message ?? text;
    } catch {
      return text;
    }
  } catch {
    return '';
  }
}
