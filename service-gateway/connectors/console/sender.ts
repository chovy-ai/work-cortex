import type { ConnectorPort, Conversation } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";

/**
 * 02 · 控制台渠道出口。
 * 结果/进度由 runtime 单一写者落盘到 outputs/<run_id>/.gateway/events.ndjson，
 * 控制台 GUI 直读文件系统呈现，故这里无需外发——只记 debug 日志。
 * 保留 ConnectorPort 形态以复用 Sessions 的回执/回流路径（无 react → 走文本降级，同样是 no-op）。
 */
export class ConsoleSender implements ConnectorPort {
  constructor(private log: Logger) {}

  async sendText(conv: Conversation, text: string): Promise<void> {
    this.log("debug", "console.sender", "sendText (noop, surfaced via filesystem)", {
      conv: conv.id,
      text: text.slice(0, 80),
    });
  }

  async sendResult(conv: Conversation, runId: string, _summaryMarkdown: string): Promise<void> {
    this.log("debug", "console.sender", "sendResult (noop, surfaced via filesystem)", {
      conv: conv.id,
      run_id: runId,
    });
  }
}
