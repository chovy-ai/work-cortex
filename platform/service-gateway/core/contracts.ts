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
  // status：给 IM 看的叙述；detail（可选）：原始工具调用 title，给控制台看原始内容
  | { kind: "progress"; status: string; detail?: string }
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

// ConnectorPort（ask 仍归 M1；send_progress / update_progress 已落地，长任务进度原地更新）
export interface ConnectorPort {
  sendText(conversation: Conversation, text: string): Promise<void>;
  sendResult(conversation: Conversation, runId: string, summaryMarkdown: string): Promise<void>;
  /** 可选：发送一条「可原地更新」的进度消息，返回消息句柄（如飞书 message_id）。不支持的渠道不实现，core 自动降级为逐条 sendText。 */
  sendProgress?(conversation: Conversation, runId: string, status: string): Promise<string | null>;
  /** 可选：原地更新 sendProgress 返回句柄对应的进度消息——长任务只占一条气泡，不刷屏。 */
  updateProgress?(conversation: Conversation, handle: string, status: string): Promise<void>;
  /** 可选：对源消息贴表情回应（飞书 reaction），返回可撤销句柄。不支持的渠道不实现，core 自动降级为文本。 */
  react?(conversation: Conversation, emojiType: string): Promise<string | null>;
  /** 可选：撤掉之前贴的表情回应（handle 来自 react 返回值）。 */
  unreact?(conversation: Conversation, handle: string): Promise<void>;
  /**
   * 可选：发一条带按钮的交互卡片（人在环 gate）。按钮点击经渠道回调译回 kind:"action"
   * 的 Envelope（携带 run_id + action_id）。不支持的渠道不实现，core 自动降级为文本 + 打字回复。
   */
  sendActionCard?(
    conversation: Conversation,
    runId: string,
    prompt: string,
    actions: { label: string; action_id: "confirm" | "revise" | "cancel" }[],
  ): Promise<void>;
}

export function encodeConversationRef(channel: string, conversation: Conversation): string {
  return Buffer.from(JSON.stringify({ channel, conversation }), "utf8").toString("base64url");
}

export function decodeConversationRef(ref: string): { channel: string; conversation: Conversation } {
  return JSON.parse(Buffer.from(ref, "base64url").toString("utf8"));
}
