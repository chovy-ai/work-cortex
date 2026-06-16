import { execFile } from "node:child_process";
import type { ConnectorPort, Conversation } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";

const RETRIES = 2;
const RETRY_BASE_MS = 500;

/**
 * 02 · 出站 sender：ConnectorPort 的 lark 实现。每次调用 spawn 一次 lark-cli 短命令；
 * 失败重试 ×2（指数退避），仍失败抛出由调用方记日志（不回滚 run）。
 * 有 source_message_id 用 +messages-reply（thread 内回复原消息），否则 +messages-send。
 */
export class LarkSender implements ConnectorPort {
  constructor(
    private opts: { bin: string; log: Logger },
  ) {}

  async sendText(conversation: Conversation, text: string): Promise<void> {
    await this.send(conversation, ["--text", text]);
  }

  async sendResult(conversation: Conversation, _runId: string, summaryMarkdown: string): Promise<void> {
    await this.send(conversation, ["--markdown", summaryMarkdown]);
  }

  /** 发一条可原地更新的进度文本，返回 message_id 句柄（拿不到则 null，core 退回逐条追加）。 */
  async sendProgress(conversation: Conversation, _runId: string, status: string): Promise<string | null> {
    return parseMessageId(await this.send(conversation, ["--text", status]));
  }

  /** 原地更新进度消息：飞书 PATCH /im/v1/messages/:id（仅文本/富文本可改），不新增气泡。 */
  async updateProgress(_conversation: Conversation, handle: string, status: string): Promise<void> {
    await this.exec([
      "api", "PATCH", `/open-apis/im/v1/messages/${handle}`, "--as", "bot",
      "--data", JSON.stringify({ msg_type: "text", content: JSON.stringify({ text: status }) }),
    ]);
  }

  /** 对源消息贴表情回应，返回 reaction_id 句柄（"OK"/"MUSCLE" 已实测有效） */
  async react(conversation: Conversation, emojiType: string): Promise<string | null> {
    if (!conversation.source_message_id) throw new Error("react requires source_message_id");
    const stdout = await this.exec([
      "im", "reactions", "create", "--as", "bot",
      "--params", JSON.stringify({ message_id: conversation.source_message_id }),
      "--data", JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    ]);
    try {
      const json = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { data?: { reaction_id?: string } };
      return json.data?.reaction_id ?? null;
    } catch {
      return null; // 贴上了但拿不到句柄：不挡流程，只是撤不掉
    }
  }

  /** 撤掉 reaction（回复前撤掉「工作中」表情） */
  async unreact(conversation: Conversation, handle: string): Promise<void> {
    if (!conversation.source_message_id) return;
    await this.exec([
      "im", "reactions", "delete", "--as", "bot",
      "--params", JSON.stringify({ message_id: conversation.source_message_id, reaction_id: handle }),
    ]);
  }

  private async send(conversation: Conversation, contentArgs: string[]): Promise<string> {
    // 显式钉死 bot 身份（设计语义），不依赖 lark-cli 的 auto-detect
    const args = conversation.source_message_id
      ? ["im", "+messages-reply", "--as", "bot", "--message-id", conversation.source_message_id, "--reply-in-thread", ...contentArgs]
      : ["im", "+messages-send", "--as", "bot", "--chat-id", conversation.id, ...contentArgs];
    let lastErr: unknown;
    for (let i = 0; i <= RETRIES; i++) {
      try {
        return await this.exec(args);
      } catch (err) {
        lastErr = err;
        this.opts.log("warn", "lark.sender", "send failed", { try: i + 1, error: String(err).slice(0, 300) });
        if (i < RETRIES) await sleep(RETRY_BASE_MS * 2 ** i);
      }
    }
    throw lastErr;
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.opts.bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(`${err.message}; stderr: ${String(stderr).slice(0, 300)}`));
        else resolve(String(stdout));
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从 lark-cli send 输出里抠 message_id（与 react 解析 reaction_id 同套路）；拿不到返回 null。 */
function parseMessageId(stdout: string): string | null {
  try {
    const json = JSON.parse(stdout.slice(stdout.indexOf("{"))) as { data?: { message_id?: string } };
    return json.data?.message_id ?? null;
  } catch {
    return null;
  }
}
