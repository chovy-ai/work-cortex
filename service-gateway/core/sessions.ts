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
  progressHandle: Promise<string | null> | null; // 进度消息句柄：首条发出后原地更新，长任务只占一条气泡
}

// 进度外发节流：原地更新不刷屏，间隔只需防 API 频控，可以勤一点；
// 降级到逐条追加的渠道则拉长到 30s，避免一长串「分析中…」气泡淹没答案。
const PROGRESS_UPDATE_INTERVAL_MS = 5_000;
const PROGRESS_APPEND_INTERVAL_MS = 30_000;

// 回执用飞书 reaction 做状态指示器（用户定，2026-06-12）：
// 贴 💪 = 正在工作中；回复发出前撤掉。文本短代码实测不渲染已弃用。
// 测试用这些常量过滤非业务回复，改文案时保持前缀可识别。
export const RECEIPT_REACTION = "Typing"; // 敲键盘 = 工作中（用户定；key 大小写敏感，"TYPING" 无效）
export const RECEIPT_TEXT = "收到，正在分析…（通常需要几分钟）"; // 渠道不支持 reaction 时的降级
export const RECEIPT_QUEUED_TEXT = "收到，前面还有问题在处理，轮到它会接着答。"; // 排队回执的文本降级
export const OVERFLOW_TEXT = "最近问题有点多，这条暂时没接住，方便的话稍后再发一次。"; // pending 溢出提示
export const PROGRESS_PREFIX = "分析中：";

export interface SessionsOpts {
  capabilityId: string;
  timeoutSec: number;
  pendingLimit: number;
  terminalKeep: number; // 终态记录 LRU 容量
  submit: (task: Task) => void;
  sender: ConnectorPort; // 默认出口（飞书）
  senderByChannel?: Record<string, ConnectorPort>; // 按渠道覆盖（如 console → 文件系统直读，no-op 出口）
  progressIntervalMs?: number; // 测试用：覆盖进度节流间隔（生产留空，按渠道能力取上面两个常量）
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
  // 排队项带上回执句柄：排队时已贴的「工作中」reaction 在真正开跑时沿用，不重复贴
  private pending = new Map<string, { env: Envelope; receipt: Promise<string | null> | null }[]>();
  private overflowed = new Set<string>(); // 已就溢出提示过的会话（成功入队后重置，每轮只提示一次）
  private terminalOrder: string[] = [];

  constructor(private opts: SessionsOpts) {}

  /** 按渠道挑出口；无覆盖则用默认 sender。 */
  private senderForChannel(channel: string): ConnectorPort {
    return this.opts.senderByChannel?.[channel] ?? this.opts.sender;
  }

  private senderFor(rec: RunRecord): ConnectorPort {
    return this.senderForChannel(rec.channel);
  }

  /**
   * 回执：源消息贴「工作中」reaction，返回可撤句柄；渠道不支持 reaction 时降级文本回执，返回 null。
   * queued=true 用排队文案（仅文本降级时区分；reaction 两种情况都贴 Typing，含义都是「收到，在处理」）。
   */
  private establishReceipt(channel: string, conversation: Conversation, queued: boolean): Promise<string | null> | null {
    const sender = this.senderForChannel(channel);
    const fallbackText = queued ? RECEIPT_QUEUED_TEXT : RECEIPT_TEXT;
    if (sender.react && conversation.source_message_id) {
      return sender.react(conversation, RECEIPT_REACTION).catch((err) => {
        this.opts.log("warn", "sessions", "receipt reaction failed, falling back to text", {
          error: String(err).slice(0, 200),
        });
        void sender.sendText(conversation, fallbackText).catch(() => {});
        return null;
      });
    }
    void sender.sendText(conversation, fallbackText).catch((err) =>
      this.opts.log("error", "sessions", "receipt text failed", { error: String(err).slice(0, 200) }),
    );
    return null;
  }

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
        if (!this.overflowed.has(key)) {
          // 别让丢弃静默无声：每轮溢出提示一次（成功入队后复位），免得用户连发时被刷屏
          this.overflowed.add(key);
          void this.senderForChannel(env.channel).sendText(env.conversation, OVERFLOW_TEXT).catch(() => {});
        }
        return;
      }
      this.overflowed.delete(key);
      // 排队也回执：贴「工作中」reaction，别让用户以为追问被无视；句柄随排队项带到开跑时沿用
      const receipt = this.establishReceipt(env.channel, env.conversation, true);
      q.push({ env, receipt });
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
        const sender = this.senderFor(rec);
        const canUpdate = !!(sender.sendProgress && sender.updateProgress);
        const interval = this.opts.progressIntervalMs ?? (canUpdate ? PROGRESS_UPDATE_INTERVAL_MS : PROGRESS_APPEND_INTERVAL_MS);
        const now = Date.now();
        if (now - rec.lastProgressSentAt < interval) return;
        rec.lastProgressSentAt = now;
        const text = `${PROGRESS_PREFIX}${ev.status.slice(0, 120)}`;
        if (!canUpdate) {
          // 渠道不支持原地更新 → 降级逐条追加（30s 间隔防刷屏）
          this.deliver(rec, (s) => s.sendText(rec.conversation, text));
        } else if (rec.progressHandle === null) {
          // 首条进度：发新消息并记下句柄（立即占位，防节流窗口内重复发新气泡）；失败则复位待重试
          rec.progressHandle = sender.sendProgress!(rec.conversation, rec.run_id, text).catch((err) => {
            this.opts.log("warn", "sessions", "progress send failed", { run_id: rec.run_id, error: String(err).slice(0, 200) });
            rec.progressHandle = null;
            return null;
          });
        } else {
          // 后续进度：原地更新同一条消息，不新增气泡
          void (async () => {
            const handle = await rec.progressHandle!.catch(() => null);
            if (!handle) return;
            await sender.updateProgress!(rec.conversation, handle, text).catch((err) =>
              this.opts.log("warn", "sessions", "progress update failed (next refresh retries)", {
                run_id: rec.run_id,
                error: String(err).slice(0, 200),
              }),
            );
          })();
        }
        return;
      }
      case "result":
        this.finish(rec, "done");
        this.deliverAfterClearingReceipt(rec, (s) => s.sendResult(rec.conversation, rec.run_id, ev.summary));
        return;
      case "error":
        this.finish(rec, "failed");
        this.deliverAfterClearingReceipt(rec, (s) => s.sendText(rec.conversation, `分析失败：${friendlyError(ev.reason)}`));
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

  private startRun(key: string, env: Envelope, existingReceipt?: Promise<string | null> | null): void {
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
      lastProgressSentAt: 0, // 回执是 reaction（非气泡），首条进度可立即发，不必再等一个节流窗口
      receiptHandle: null,
      progressHandle: null,
    };
    this.runs.set(runId, rec);
    this.activeByConv.set(key, runId);
    this.runConv.set(runId, key);
    this.opts.log("info", "sessions", "run started", { run_id: runId, conv: key });
    // 回执：排队期已贴过 reaction 的沿用同一句柄（不重复贴）；否则现贴「工作中」reaction（💪）
    rec.receiptHandle = existingReceipt !== undefined ? existingReceipt : this.establishReceipt(env.channel, env.conversation, false);
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
    if (next) this.startRun(key, next.env, next.receipt);
  }

  private deliver(rec: RunRecord, send: (s: ConnectorPort) => Promise<void>): void {
    // 发送失败不改变 run 状态（02 已定）：记日志放弃
    void send(this.senderFor(rec)).catch((err) =>
      this.opts.log("error", "sessions", "delivery failed (run state unchanged)", {
        run_id: rec.run_id,
        error: String(err),
      }),
    );
  }

  /** 终态回复：先撤掉「工作中」reaction（用户定的顺序），再发回复。撤失败不挡回复。 */
  private deliverAfterClearingReceipt(rec: RunRecord, send: (s: ConnectorPort) => Promise<void>): void {
    void (async () => {
      const sender = this.senderFor(rec);
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

/**
 * 系统级失败原因 → 给业务同学看的人话（原始 reason 仍在 events.ndjson / 日志里供排查）。
 * 不糖衣坏消息，只是把「agent 未产出回复内容」「执行超时（600s）」这类工程腔翻成能看懂的话。
 */
function friendlyError(reason: string): string {
  if (/超时/.test(reason)) return "这次没能在限定时间内查完。把问题问得更具体些（比如限定某一天、单个指标）再试一次，通常会快很多。";
  if (/未产出/.test(reason)) return "这次没能得出结果，麻烦换个问法或稍后再试一次。";
  if (/能力执行异常|违约|运行目录创建失败/.test(reason)) return "分析过程中出了点状况，没能完成，请稍后重试。";
  return reason; // 其余（如能力自己报的具体原因）已是给人看的话，原样透传
}

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `run_${ts}_${randomBytes(2).toString("hex")}`;
}

export { decodeConversationRef };
