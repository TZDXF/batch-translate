/**
 * e2e 本地 mock LLM server（任务约束：不依赖真实 API Key）。
 *
 * 模拟 OpenAI 兼容 `POST {baseUrl}/chat/completions` 端点：
 *  - 默认把请求 items JSON 原样回填（每段 text 前缀「译：」），便于断言双语渲染。
 *  - 可注入自定义 responder（按请求计数 / 内容分支），覆盖 batch-protocol / concurrency / cache 场景。
 *  - 统计请求次数、在途并发峰值、每次请求的 items，供 spec 断言「请求数 << 段落数」「并发不超上限」。
 *
 * 纯 Node http，无依赖（不引 express，保持 e2e 零额外安装）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** 单次请求的记录。 */
export interface MockRequest {
  /** 请求序号（从 0 起）。 */
  index: number;
  /** 请求 body 里的 items（id 列表）。 */
  ids: string[];
  /** 收到请求的时间戳（ms）。 */
  at: number;
}

export interface MockResponderResult {
  /** HTTP 状态码，默认 200。 */
  status?: number;
  /** 返回的 content（OpenAI choices[0].message.content）。 */
  content: string;
  /** 模拟慢响应：响应前等待的毫秒数（concurrency spec 用）。 */
  delayMs?: number;
}

/**
 * 自定义 responder：根据请求 items 与序号决定返回内容。
 * 返回 null 表示走默认「译：」回填。
 */
export type MockResponder = (ids: string[], index: number) => MockResponderResult | null | Promise<MockResponderResult | null>;

export interface MockServer {
  /** server 监听的 base url，如 http://127.0.0.1:54321/v1（无尾斜杠）。 */
  baseUrl: string;
  /** 已收到的全部请求记录。 */
  requests: MockRequest[];
  /** 当前在途请求数（concurrency 断言用）。 */
  readonly inFlight: number;
  /** 在途并发峰值。 */
  readonly peakInFlight: number;
  /** 设置自定义 responder（替换默认）。 */
  setResponder(fn: MockResponder): void;
  /** 重置统计 + responder（spec 间隔离）。 */
  reset(): void;
  /** 关闭 server。 */
  close(): Promise<void>;
}

/** 默认回填：每段 text 前缀「译：」。 */
function defaultRespond(ids: string[]): string {
  return JSON.stringify({ items: ids.map((id) => ({ id, text: `译：${id}` })) });
}

/**
 * 启动 mock LLM server。返回的 baseUrl 形如 `http://127.0.0.1:<port>/v1`，
 * 直接作为引擎 baseUrl 注入扩展配置（请求打到 `${baseUrl}/chat/completions`）。
 */
export async function startMockLLM(): Promise<MockServer> {
  const requests: MockRequest[] = [];
  let responder: MockResponder | null = null;
  let inFlight = 0;
  let peakInFlight = 0;
  let reqIndex = 0;

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const body = await readBody(req);
    const ids = parseIds(body);
    const index = reqIndex++;
    const record: MockRequest = { index, ids, at: Date.now() };
    requests.push(record);
    inFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);

    try {
      let result: MockResponderResult | null = null;
      if (responder) result = await responder(ids, index);
      if (!result) result = { content: defaultRespond(ids) };

      if (result.delayMs) await sleep(result.delayMs);

      res.statusCode = result.status ?? 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: result.content } }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
      );
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: { message: String(err) } }));
    } finally {
      inFlight--;
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  return {
    baseUrl,
    requests,
    get inFlight() {
      return inFlight;
    },
    get peakInFlight() {
      return peakInFlight;
    },
    setResponder(fn) {
      responder = fn;
    },
    reset() {
      requests.length = 0;
      responder = null;
      inFlight = 0;
      peakInFlight = 0;
      reqIndex = 0;
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 从请求 body 解析出 items 的 id 列表（orchestrator 经 protocol.buildUserMessage 产出 {items:[{id,text}]}）。 */
function parseIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { items?: Array<{ id: string }> };
    if (Array.isArray(parsed.items)) return parsed.items.map((i) => String(i.id));
  } catch {
    /* ignore */
  }
  return [];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
