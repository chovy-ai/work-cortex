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
  if (!header?.event_id || header?.event_type !== "im.message.receive_v1") return null;

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
