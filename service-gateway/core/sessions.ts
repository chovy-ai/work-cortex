import { randomBytes } from "node:crypto";
import type { ConnectorPort, Conversation, Envelope, Task, TaskEvent } from "./contracts.js";
import { encodeConversationRef, decodeConversationRef } from "./contracts.js";
import { assertValid } from "./validate.js";
import type { Logger } from "./log.js";

export interface RunRecord {
  run_id: string;
  channel: string;
  conversation: Conversation;
  status: "running" | "done" | "failed";
  created_at: string;
  lastProgressSentAt: number; // 进度外发节流（ms epoch）
  receiptHandle: Promise<string | null> | null; // 「工作中」reaction 句柄（回复前撤掉）
}

/** 进度文本外发的最小间隔（用户要求执行过程可见，2026-06-12；M1 卡片替代） */
const PROGRESS_INTERVAL_MS = 30_000;

// 回执用飞书 reaction 做状态指示器（用户定，2026-06-12）：
// 贴 💪 = 正在工作中；回复发出前撤掉。文本短代码实测不渲染已弃用。
// 测试用这些常量过滤非业务回复，改文案时保持前缀可识别。
export const RECEIPT_REACTION = "MUSCLE"; // 💪 工作中（create/delete 均已实测）
export const RECEIPT_TEXT = "收到，正在分析…（通常需要几分钟）"; // 渠道不支持 reaction 时的降级
export const PROGRESS_PREFIX = "分析中：";

export interface SessionsOpts {
  capabilityId: string;
  timeoutSec: number;
  pendingLimit: number;
  terminalKeep: number; // 终态记录 LRU 容量
  submit: (task: Task) => void;
  sender: ConnectorPort;
  log: Logger;
}

/**
 * 04 · 会话映射与 run 状态。
 * 判定表：p2p message 无 running → 开 run；有 running → per-conversation FIFO（串行）；
 * 群聊 / action / system → 忽略。回流：result/error 终态 + 寻址回原会话 → 弹下一条 pending。
 */
export class Sessions {
  private runs = new Map<string, RunRecord>();
  private activeByConv = new Map<string, string>(); // convKey → run_id
  private runConv = new Map<string, string>(); // run_id → convKey
  private pending = new Map<string, Envelope[]>();
  private terminalOrder: string[] = [];

  constructor(private opts: SessionsOpts) {}

  runStatus(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  handleEnvelope(env: Envelope): void {
    const log = this.opts.log;
    if (env.kind !== "message") {
      log(env.kind === "action" ? "warn" : "debug", "sessions", `ignored kind=${env.kind} (M0)`, {
        event_id: env.event_id,
      });
      return;
    }
    if (env.conversation.type === "group") {
      log("debug", "sessions", "group message ignored (M0)", { event_id: env.event_id });
      return;
    }
    const key = this.convKey(env);
    if (this.activeByConv.has(key)) {
      const q = this.pending.get(key) ?? [];
      if (q.length >= this.opts.pendingLimit) {
        log("error", "sessions", "pending limit reached, message dropped", { conv: key, limit: this.opts.pendingLimit });
        return;
      }
      q.push(env);
      this.pending.set(key, q);
      log("info", "sessions", "queued behind running run", { conv: key, depth: q.length });
      return;
    }
    this.startRun(key, env);
  }

  handleEvent(ev: TaskEvent): void {
    const log = this.opts.log;
    const rec = this.runs.get(ev.run_id);
    if (!rec || rec.status !== "running") {
      log("warn", "sessions", "event for unknown/terminal run dropped", { run_id: ev.run_id, kind: ev.kind });
      return;
    }
    switch (ev.kind) {
      case "progress": {
        // 节流外发执行进度（runtime 已落 events.ndjson，这里只管用户可见性）
        const now = Date.now();
        if (now - rec.lastProgressSentAt >= PROGRESS_INTERVAL_MS) {
          rec.lastProgressSentAt = now;
          this.deliver(rec, (s) => s.sendText(rec.conversation, `${PROGRESS_PREFIX}${ev.status.slice(0, 120)}`));
        }
        return;
      }
      case "result":
        this.finish(rec, "done");
        this.deliverAfterClearingReceipt(rec, (s) => s.sendResult(rec.conversation, rec.run_id, ev.summary));
        return;
      case "error":
        this.finish(rec, "failed");
        this.deliverAfterClearingReceipt(rec, (s) => s.sendText(rec.conversation, `分析失败：${ev.reason}`));
        return;
      case "ask":
      case "signal":
        // M0 不应出现（04 判定表）：warn + 按 error 收尾
        log("warn", "sessions", `unexpected ${ev.kind} in M0, failing run`, { run_id: ev.run_id });
        this.finish(rec, "failed");
        this.deliverAfterClearingReceipt(rec, (s) =>
          s.sendText(rec.conversation, "分析失败：能力返回了当前版本不支持的事件"),
        );
        return;
    }
  }

  /** 仅供观测/优雅退出统计 */
  get runningCount(): number {
    return this.activeByConv.size;
  }

  private startRun(key: string, env: Envelope): void {
    const runId = newRunId();
    const task: Task = {
      v: 1,
      run_id: runId,
      capability: this.opts.capabilityId,
      input: { text: env.message!.text, attachments: [] },
      context: {
        principal: { member: env.principal.channel_user_id, roles: [] },
        conversation_ref: encodeConversationRef(env.channel, env.conversation),
        history: [],
      },
      resume: null,
      limits: { timeout_s: this.opts.timeoutSec },
    };
    assertValid("task", task); // 接缝二下发前校验
    const rec: RunRecord = {
      run_id: runId,
      channel: env.channel,
      conversation: env.conversation,
      status: "running",
      created_at: new Date().toISOString(),
      lastProgressSentAt: Date.now(), // 回执已发，首条进度 30s 后再说
      receiptHandle: null,
    };
    this.runs.set(runId, rec);
    this.activeByConv.set(key, runId);
    this.runConv.set(runId, key);
    this.opts.log("info", "sessions", "run started", { run_id: runId, conv: key });
    // 回执：贴「工作中」reaction（💪）在源消息上；渠道不支持或失败 → 降级文本
    const sender = this.opts.sender;
    if (sender.react && rec.conversation.source_message_id) {
      rec.receiptHandle = sender.react(rec.conversation, RECEIPT_REACTION).catch((err) => {
        this.opts.log("warn", "sessions", "receipt reaction failed, falling back to text", {
          run_id: runId,
          error: String(err).slice(0, 200),
        });
        this.deliver(rec, (s) => s.sendText(rec.conversation, RECEIPT_TEXT));
        return null;
      });
    } else {
      this.deliver(rec, (s) => s.sendText(rec.conversation, RECEIPT_TEXT));
    }
    this.opts.submit(task);
  }

  private finish(rec: RunRecord, status: "done" | "failed"): void {
    rec.status = status;
    this.opts.log("info", "sessions", `run ${status}`, { run_id: rec.run_id });
    const key = this.runConv.get(rec.run_id);
    this.runConv.delete(rec.run_id);
    this.archive(rec.run_id);
    if (!key) return;
    this.activeByConv.delete(key);
    const q = this.pending.get(key);
    const next = q?.shift();
    if (q && q.length === 0) this.pending.delete(key);
    if (next) this.startRun(key, next);
  }

  private deliver(rec: RunRecord, send: (s: ConnectorPort) => Promise<void>): void {
    // 发送失败不改变 run 状态（02 已定）：记日志放弃
    void send(this.opts.sender).catch((err) =>
      this.opts.log("error", "sessions", "delivery failed (run state unchanged)", {
        run_id: rec.run_id,
        error: String(err),
      }),
    );
  }

  /** 终态回复：先撤掉「工作中」reaction（用户定的顺序），再发回复。撤失败不挡回复。 */
  private deliverAfterClearingReceipt(rec: RunRecord, send: (s: ConnectorPort) => Promise<void>): void {
    void (async () => {
      const sender = this.opts.sender;
      if (rec.receiptHandle && sender.unreact) {
        const handle = await rec.receiptHandle.catch(() => null);
        if (handle) {
          await sender.unreact(rec.conversation, handle).catch((err) =>
            this.opts.log("warn", "sessions", "unreact failed (reply proceeds)", {
              run_id: rec.run_id,
              error: String(err).slice(0, 200),
            }),
          );
        }
      }
      await send(sender).catch((err) =>
        this.opts.log("error", "sessions", "delivery failed (run state unchanged)", {
          run_id: rec.run_id,
          error: String(err),
        }),
      );
    })();
  }

  private archive(runId: string): void {
    this.terminalOrder.push(runId);
    while (this.terminalOrder.length > this.opts.terminalKeep) {
      const evicted = this.terminalOrder.shift()!;
      this.runs.delete(evicted);
    }
  }

  private convKey(env: Envelope): string {
    return `${env.channel}:${env.conversation.id}:${env.conversation.thread_id ?? ""}`;
  }
}

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `run_${ts}_${randomBytes(2).toString("hex")}`;
}

export { decodeConversationRef };
