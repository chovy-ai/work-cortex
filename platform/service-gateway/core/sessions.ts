import { randomBytes } from "node:crypto";
import type { ConnectorPort, Conversation, Envelope, Task, TaskEvent } from "./contracts.js";
import { encodeConversationRef, decodeConversationRef } from "./contracts.js";
import { assertValid } from "./validate.js";
import type { Logger } from "./log.js";

export interface RunRecord {
  run_id: string;
  channel: string;
  conversation: Conversation;
  member: string; // 发起人（principal），resume 时重建 Task 需要
  status: "running" | "awaiting" | "done" | "failed"; // awaiting=已发问、挂起等用户回复（人在环 gate）
  created_at: string;
  lastProgressSentAt: number; // 进度外发节流（ms epoch）
  receiptHandle: Promise<string | null> | null; // 「工作中」reaction 句柄（回复前撤掉）
  receiptPosted: boolean; // 是否已贴回执——真正开跑（首个 progress）才贴，排队/等槽期间不贴
  progressHandle: Promise<string | null> | null; // 进度消息句柄：首条发出后原地更新，长任务只占一条气泡
  awaitOptions?: string[]; // 挂起时 ask 给出的选项（["确认","修改","取消"] 或 []），用于解释用户回复
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
  private pending = new Map<string, { env: Envelope }[]>();
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

    // 卡片动作（confirm/revise/cancel）：路由到对应 run 的 resume；无挂起 run 则忽略
    if (env.kind === "action") {
      const a = env.action;
      const rec = a ? this.runs.get(a.run_id) : undefined;
      if (!a || !rec || rec.status !== "awaiting") {
        log("debug", "sessions", "action without awaiting run ignored", { event_id: env.event_id, run_id: a?.run_id });
        return;
      }
      this.resumeRun(rec, a.action_id, a.params ?? {});
      return;
    }

    if (env.kind !== "message") {
      log("debug", "sessions", `ignored kind=${env.kind} (M0)`, { event_id: env.event_id });
      return;
    }
    if (env.conversation.type === "group") {
      log("debug", "sessions", "group message ignored (M0)", { event_id: env.event_id });
      return;
    }
    const key = this.convKey(env);
    const activeId = this.activeByConv.get(key);
    if (activeId) {
      const rec = this.runs.get(activeId);
      // 该会话有 run 正挂起等回复 → 这条消息就是用户的回答，路由到 resume（不排队）
      if (rec && rec.status === "awaiting") {
        const { action_id, params } = mapReply(env.message!.text, rec.awaitOptions ?? []);
        this.resumeRun(rec, action_id, params);
        return;
      }
      // 否则该会话有 run 在跑 → per-conversation FIFO 排队
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
      // 排队时不贴表情（用户定：真正开跑才贴）；轮到它 startRun 后由首个 progress 触发回执。
      q.push({ env });
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
        // 真正开跑：首个 progress 才贴「工作中」回执（💪）——排队/等并发槽期间不贴。
        if (!rec.receiptPosted) {
          rec.receiptPosted = true;
          rec.receiptHandle = this.establishReceipt(rec.channel, rec.conversation, false);
        }
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
      case "ask": {
        // 人在环 gate：把问题发给用户，run 转 awaiting（不终结、不归档、仍占着会话），
        // 用户回复经 resume 续跑。撤掉「工作中」回执——此刻是用户该动了。
        rec.status = "awaiting";
        rec.awaitOptions = ev.options;
        rec.lastProgressSentAt = 0;
        rec.progressHandle = null; // 续跑后进度重新发一条新气泡
        const sender = this.senderFor(rec);
        if (ev.options.length && sender.sendActionCard) {
          // 有选项 + 渠道支持卡片 → 发带按钮的交互卡片；点击经 card.action.trigger 回调续跑。
          // 同时打字回「确认/取消」仍可用（mapReply），两条路都通。
          const actions = ev.options.map((label) => ({ label, action_id: LABEL_TO_ACTION[label] ?? "revise" }));
          this.deliverAfterClearingReceipt(rec, (s) => s.sendActionCard!(rec.conversation, ev.run_id, ev.prompt, actions));
        } else {
          // 无选项（澄清追问）或渠道不支持卡片 → 文本 + 打字回复兜底
          const lines = [ev.prompt];
          if (ev.options.length) lines.push(`\n请回复：${ev.options.join(" / ")}`);
          this.deliverAfterClearingReceipt(rec, (s) => s.sendText(rec.conversation, lines.join("\n")));
        }
        log("info", "sessions", "run awaiting user input", { run_id: ev.run_id, options: ev.options.length });
        return;
      }
      case "signal":
        // signal 仍不支持：warn + 按 error 收尾
        log("warn", "sessions", "unexpected signal, failing run", { run_id: ev.run_id });
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
      member: env.principal.channel_user_id,
      status: "running",
      created_at: new Date().toISOString(),
      lastProgressSentAt: 0, // 回执是 reaction（非气泡），首条进度可立即发，不必再等一个节流窗口
      receiptHandle: null,
      receiptPosted: false,
      progressHandle: null,
    };
    this.runs.set(runId, rec);
    this.activeByConv.set(key, runId);
    this.runConv.set(runId, key);
    this.opts.log("info", "sessions", "run started", { run_id: runId, conv: key });
    // 回执（💪）不在此处贴——真正开跑（runtime 给槽、runner 发首个 progress）时才贴，见 handleEvent。
    this.opts.submit(task);
  }

  /**
   * 续跑一个挂起（awaiting）的 run：用同一 run_id 提交带 resume 的 Task。
   * runner 据 run_id 从 outputs/<run_id>/state.json 恢复调度器状态、provide_input 后继续。
   */
  private resumeRun(rec: RunRecord, action_id: "confirm" | "revise" | "cancel", params: Record<string, unknown>): void {
    rec.status = "running";
    rec.awaitOptions = undefined;
    rec.lastProgressSentAt = 0;
    rec.progressHandle = null;
    rec.receiptPosted = false;
    const task: Task = {
      v: 1,
      run_id: rec.run_id,
      capability: this.opts.capabilityId,
      input: { text: typeof params["text"] === "string" ? (params["text"] as string) : "", attachments: [] },
      context: {
        principal: { member: rec.member, roles: [] },
        conversation_ref: encodeConversationRef(rec.channel, rec.conversation),
        history: [],
      },
      resume: { action_id, params },
      limits: { timeout_s: this.opts.timeoutSec },
    };
    assertValid("task", task);
    this.opts.log("info", "sessions", "run resumed", { run_id: rec.run_id, action_id });
    // 回执延迟到首个 progress（见 handleEvent）。
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
    if (next) this.startRun(key, next.env);
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

/** 卡片按钮标签 → action_id（与 mapReply 的文本识别等价，供 sendActionCard 的按钮 value 用）。 */
const LABEL_TO_ACTION: Record<string, "confirm" | "revise" | "cancel"> = {
  确认: "confirm",
  修改: "revise",
  取消: "cancel",
};

/**
 * 用户对人在环 gate 的回复 → resume 动作。
 * 有选项（方案确认 gate）：识别「确认 / 取消」，其余当「修改意见」(revise，带原文)。
 * 无选项（澄清追问）：自由文本一律作为补充信息 (revise，带原文)。
 */
function mapReply(text: string, options: string[]): { action_id: "confirm" | "revise" | "cancel"; params: Record<string, unknown> } {
  const t = text.trim();
  if (options.length) {
    if (/确认|确定|^(是|对|ok|yes|y)$/i.test(t)) return { action_id: "confirm", params: {} };
    if (/取消|算了|^(不了?|no|n)$/i.test(t)) return { action_id: "cancel", params: {} };
    return { action_id: "revise", params: { text: t } };
  }
  return { action_id: "revise", params: { text: t } };
}

function newRunId(): string {
  const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "Z");
  return `run_${ts}_${randomBytes(2).toString("hex")}`;
}

export { decodeConversationRef };
