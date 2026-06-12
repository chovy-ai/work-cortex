// 契约 TS 形态。运行时真相源是同目录 *.schema.json（ajv 校验）；
// core/generated/ 下另有 json2ts 生成物作为 CI 防漂移工件。

export interface Conversation {
  id: string;
  thread_id: string | null;
  type: "p2p" | "group";
  source_message_id?: string | null; // R3
}

export interface Principal {
  channel_user_id: string;
  display_name?: string;
}

export interface Attachment {
  type: "image" | "file";
  ref: string;
  name?: string;
}

export interface Envelope {
  v: 1;
  event_id: string;
  dedup_key: string;
  channel: string;
  received_at: string;
  conversation: Conversation;
  principal: Principal;
  kind: "message" | "action" | "system";
  message?: { text: string; attachments?: Attachment[] };
  action?: { run_id: string; action_id: "confirm" | "revise" | "cancel"; params?: Record<string, unknown> };
  raw_ref?: string | null; // R1: M0 恒 null
}

export interface Task {
  v: 1;
  run_id: string;
  capability: string;
  input: { text: string; attachments?: unknown[] };
  context: {
    principal: { member: string; roles?: string[] };
    conversation_ref: string;
    history: unknown[];
  };
  resume: null | { action_id: "confirm" | "revise" | "cancel"; params?: Record<string, unknown> };
  limits: { timeout_s: number };
}

export interface ResultTable {
  title?: string;
  columns: string[];
  rows: (string | number | null)[][];
}

export interface ResultChart {
  title?: string;
  image_path: string;
}

// R2：runner 只 emit draft（kind + 载荷），簿记字段由 runtime 单一写者补全
export type TaskEventDraft =
  | { kind: "progress"; status: string }
  | { kind: "ask"; prompt: string; options: string[] }
  | { kind: "result"; summary: string; tables: ResultTable[]; charts: ResultChart[]; artifacts_dir?: string }
  | { kind: "error"; reason: string; retriable?: boolean }
  | { kind: "signal"; type: string; detail?: Record<string, unknown> };

export type TaskEvent = { v: 1; run_id: string; seq: number; at: string } & TaskEventDraft;

export type RunnerFn = (
  task: Task,
  emit: (draft: TaskEventDraft) => void,
  signal: AbortSignal,
) => Promise<void>;

// ConnectorPort 的 M0 子集（send_progress / update_progress / ask 归 M1）
export interface ConnectorPort {
  sendText(conversation: Conversation, text: string): Promise<void>;
  sendResult(conversation: Conversation, runId: string, summaryMarkdown: string): Promise<void>;
  /** 可选：对源消息贴表情回应（飞书 reaction），返回可撤销句柄。不支持的渠道不实现，core 自动降级为文本。 */
  react?(conversation: Conversation, emojiType: string): Promise<string | null>;
  /** 可选：撤掉之前贴的表情回应（handle 来自 react 返回值）。 */
  unreact?(conversation: Conversation, handle: string): Promise<void>;
}

export function encodeConversationRef(channel: string, conversation: Conversation): string {
  return Buffer.from(JSON.stringify({ channel, conversation }), "utf8").toString("base64url");
}

export function decodeConversationRef(ref: string): { channel: string; conversation: Conversation } {
  return JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
}
