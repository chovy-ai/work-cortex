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

  /** 对源消息贴表情回应（emoji_type 见飞书表情文案说明；"OK" 已实测有效） */
  async react(conversation: Conversation, emojiType: string): Promise<void> {
    if (!conversation.source_message_id) throw new Error("react requires source_message_id");
    await this.exec([
      "im", "reactions", "create", "--as", "bot",
      "--params", JSON.stringify({ message_id: conversation.source_message_id }),
      "--data", JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    ]);
  }

  private async send(conversation: Conversation, contentArgs: string[]): Promise<void> {
    // 显式钉死 bot 身份（设计语义），不依赖 lark-cli 的 auto-detect
    const args = conversation.source_message_id
      ? ["im", "+messages-reply", "--as", "bot", "--message-id", conversation.source_message_id, "--reply-in-thread", ...contentArgs]
      : ["im", "+messages-send", "--as", "bot", "--chat-id", conversation.id, ...contentArgs];
    let lastErr: unknown;
    for (let i = 0; i <= RETRIES; i++) {
      try {
        await this.exec(args);
        return;
      } catch (err) {
        lastErr = err;
        this.opts.log("warn", "lark.sender", "send failed", { try: i + 1, error: String(err).slice(0, 300) });
        if (i < RETRIES) await sleep(RETRY_BASE_MS * 2 ** i);
      }
    }
    throw lastErr;
  }

  private exec(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.opts.bin, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`${err.message}; stderr: ${String(stderr).slice(0, 300)}`));
        else resolve();
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
