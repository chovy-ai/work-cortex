import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Envelope } from "../../core/contracts.js";
import type { PushResult } from "../../core/queue.js";
import { isValid, violationDetails } from "../../core/validate.js";
import type { Logger } from "../../core/log.js";

export interface ConsoleHttpOpts {
  host: string;
  port: number;
  /** 把信封塞进队列，返回队列裁决（accepted/duplicate/overflow）。 */
  push: (env: Envelope) => PushResult;
  /** 可选：/health 附带的运行态快照。 */
  status?: () => Record<string, unknown>;
  log: Logger;
}

export interface ConsoleHttpHandle {
  stop(): Promise<void>;
}

const BODY_LIMIT = 64 * 1024;
// 控制台是本机单用户、p2p 串行：用稳定会话 id，二次提交自然排在前一条之后（与飞书 p2p 同构）。
const CONSOLE_CONVERSATION_ID = "console";

/**
 * 02 · 控制台入站连接器：本机回环 HTTP。
 *   POST /query  { text }          → 译成 Envelope 入队，202 { ok, event_id }
 *   GET  /health                   → 200 { ok, ...status }
 * 结果不走 HTTP 回传——runtime 已落盘 events.ndjson，GUI 直读文件系统。
 */
export function startConsoleHttp(opts: ConsoleHttpOpts): ConsoleHttpHandle {
  const { log } = opts;
  const server = createServer((req, res) => void handle(req, res, opts));
  server.on("error", (err) => log("error", "console.http", "server error", { error: String(err) }));
  server.listen(opts.port, opts.host, () => {
    log("info", "console.http", "listening", { host: opts.host, port: opts.port });
  });

  return {
    async stop(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      log("info", "console.http", "stopped");
    },
  };
}

async function handle(req: IncomingMessage, res: ServerResponse, opts: ConsoleHttpOpts): Promise<void> {
  const url = req.url ?? "/";
  try {
    if (req.method === "GET" && (url === "/health" || url === "/")) {
      reply(res, 200, { ok: true, ...(opts.status?.() ?? {}) });
      return;
    }
    if (req.method === "POST" && url === "/query") {
      await handleQuery(req, res, opts);
      return;
    }
    reply(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    opts.log("error", "console.http", "request handler threw", { url, error: String(err).slice(0, 300) });
    try {
      reply(res, 500, { ok: false, error: "内部错误" });
    } catch {
      /* response 已发出，忽略 */
    }
  }
}

async function handleQuery(req: IncomingMessage, res: ServerResponse, opts: ConsoleHttpOpts): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req, BODY_LIMIT);
  } catch {
    reply(res, 413, { ok: false, error: "请求体过大" });
    return;
  }

  let text: string;
  try {
    const parsed = JSON.parse(raw) as { text?: unknown };
    if (typeof parsed.text !== "string" || !parsed.text.trim()) {
      reply(res, 400, { ok: false, error: "缺少非空字段 text" });
      return;
    }
    text = parsed.text.trim();
  } catch {
    reply(res, 400, { ok: false, error: "请求体不是合法 JSON" });
    return;
  }

  const eventId = randomUUID();
  const env: Envelope = {
    v: 1,
    event_id: eventId,
    dedup_key: `console:${eventId}`,
    channel: "console",
    received_at: new Date().toISOString(),
    conversation: { id: CONSOLE_CONVERSATION_ID, thread_id: null, type: "p2p" },
    principal: { channel_user_id: "console", display_name: "控制台" },
    kind: "message",
    message: { text },
    raw_ref: null,
  };
  if (!isValid("envelope", env)) {
    opts.log("error", "console.http", "built invalid envelope", { details: violationDetails("envelope") });
    reply(res, 500, { ok: false, error: "内部错误：信封校验失败" });
    return;
  }

  const result = opts.push(env);
  if (result === "accepted") {
    opts.log("info", "console.http", "query accepted", { event_id: eventId, len: text.length });
    reply(res, 202, { ok: true, event_id: eventId });
    return;
  }
  if (result === "overflow") {
    reply(res, 503, { ok: false, error: "网关繁忙，队列已满，请稍后再试" });
    return;
  }
  reply(res, 409, { ok: false, error: "重复请求" });
}

function reply(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    Connection: "close",
  });
  res.end(data);
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
