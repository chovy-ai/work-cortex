import type { Envelope } from "../../core/contracts.js";

/**
 * lark 原始事件 → Envelope（纯函数）。返回 null = 与我们无关（非消息事件、
 * 非用户发送、非文本消息），由调用方决定日志级别。
 * 字段映射基于 im.message.receive_v1 事件结构；联调时如有出入在此修正。
 */
export function translate(raw: unknown): Envelope | null {
  const r = raw as Record<string, any>;
  const header = r?.header;
  const event = r?.event;
  if (!header?.event_id) return null;

  // 卡片按钮回调 → action 信封（run_id / action_id 来自我们塞进按钮的 value）
  if (header.event_type === "card.action.trigger") return translateCardAction(header, event);

  if (header.event_type !== "im.message.receive_v1") return null;

  const sender = event?.sender;
  if (sender?.sender_type !== "user") return null; // 防自激回环：机器人/应用消息不处理

  const message = event?.message;
  if (!message?.chat_id || message?.message_type !== "text") return null;

  let text = "";
  try {
    text = String(JSON.parse(message.content ?? "{}").text ?? "");
  } catch {
    return null;
  }
  // 剥掉 @mention 占位符（"@_user_1" 形式）
  text = text.replace(/@_user_\d+/g, "").trim();

  const chatType = message.chat_type === "group" ? "group" : "p2p";

  return {
    v: 1,
    event_id: String(header.event_id),
    dedup_key: `lark:${header.event_id}`,
    channel: "lark",
    received_at: new Date().toISOString(),
    conversation: {
      id: String(message.chat_id),
      thread_id: message.thread_id ? String(message.thread_id) : null,
      type: chatType,
      source_message_id: message.message_id ? String(message.message_id) : null,
    },
    principal: {
      channel_user_id: String(sender?.sender_id?.open_id ?? "unknown"),
    },
    kind: "message",
    message: { text, attachments: [] },
    raw_ref: null,
  };
}

/**
 * card.action.trigger → action 信封。按钮 value 里带回 { action_id, run_id }（我们发卡片时塞的）；
 * 会话/发起人取自 context.open_chat_id 与 operator.open_id。run_id 不合或 action_id 非法则返回 null。
 */
function translateCardAction(header: Record<string, any>, event: Record<string, any>): Envelope | null {
  const rawVal = event?.action?.value;
  let value: Record<string, any> | null = null;
  if (rawVal && typeof rawVal === "object") value = rawVal;
  else if (typeof rawVal === "string") {
    try {
      value = JSON.parse(rawVal);
    } catch {
      value = null;
    }
  }
  const runId = value?.run_id;
  const actionId = value?.action_id;
  if (!runId || (actionId !== "confirm" && actionId !== "revise" && actionId !== "cancel")) return null;

  const ctx = event?.context ?? {};
  const chatId = ctx.open_chat_id;
  if (!chatId) return null;

  return {
    v: 1,
    event_id: String(header.event_id),
    dedup_key: `lark:${header.event_id}`,
    channel: "lark",
    received_at: new Date().toISOString(),
    conversation: {
      id: String(chatId),
      thread_id: null,
      type: "p2p",
      source_message_id: ctx.open_message_id ? String(ctx.open_message_id) : null,
    },
    principal: {
      channel_user_id: String(event?.operator?.open_id ?? "unknown"),
    },
    kind: "action",
    action: { run_id: String(runId), action_id: actionId, params: {} },
    raw_ref: null,
  };
}
