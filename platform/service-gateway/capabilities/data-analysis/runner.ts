import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentText } from "atomic-abilities";
import { decodeConversationRef, type RunnerFn, type Task, type TaskEventDraft } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";
import type { SessionStore, Turn } from "./session-store.js";

export interface SkillRunnerOpts {
  /** 分析能力本体根目录（含 build/、skills/、.env.local）。 */
  abilityRoot: string;
  /** agent 工作目录，相对仓库根（agent 在此跑 cli、读 .env.local）。 */
  abilityRelCwd: string;
  /** 会话历史存储（按会话提供上下文）。 */
  sessions: SessionStore;
  log: Logger;
}

/**
 * 06 · data-analysis 能力：skill 驱动 + 会话上下文。
 *
 * 每条消息起一次性 ACP agent（不长活），喂它 data-analytics SKILL + 本会话历史 + 当前问题；
 * agent 在能力工作目录里用 datafinder cli 自取数据、产出结论。同一会话（convKey=channel:chat:thread）
 * 的历史被回放进 prompt，故追问能带上下文；新会话从空历史开始。
 */
export function createSkillRunner(opts: SkillRunnerOpts): RunnerFn {
  const { abilityRoot, abilityRelCwd, sessions, log } = opts;
  let skill = "";
  try {
    skill = readFileSync(join(abilityRoot, "skills", "data-analytics", "SKILL.md"), "utf-8");
  } catch (err) {
    log("warn", "runner.skill", "SKILL.md 读取失败（agent 将无技能上下文）", { error: String(err).slice(0, 200) });
  }

  return async (task: Task, emit: (d: TaskEventDraft) => void, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    emit({ kind: "progress", status: "正在分析…" });

    const key = sessionKey(task);
    const history = key ? sessions.history(key) : [];
    const prompt = buildPrompt(skill, history, task.input.text);
    try {
      const answer = await runAgentText({
        prompt,
        cwd: abilityRelCwd,
        signal,
        timeoutMs: task.limits.timeout_s * 1000,
      });
      if (signal.aborted) return; // 终态由 runtime 补
      const text = answer.trim() || "（分析完成，但没有产出可读结论）";
      if (key) sessions.append(key, task.input.text, text);
      emit({ kind: "result", summary: text, tables: [], charts: [] });
    } catch (err) {
      log("error", "runner.skill", "agent 执行失败", { run_id: task.run_id, error: String(err).slice(0, 300) });
      emit({ kind: "error", reason: `分析失败：${truncate(String(err), 200)}`, retriable: false });
    }
  };
}

/** 会话键 = channel:chat:thread（与 sessions 的 convKey 一致）；解码失败返回 null。 */
function sessionKey(task: Task): string | null {
  try {
    const { channel, conversation } = decodeConversationRef(task.context.conversation_ref);
    return `${channel}:${conversation.id}:${conversation.thread_id ?? ""}`;
  } catch {
    return null;
  }
}

function buildPrompt(skill: string, history: Turn[], query: string): string {
  const lines = [
    "你是数据分析助手。下面是你的技能说明（SKILL），请严格据此回答用户问题。",
    "你可以用 Bash 运行 SKILL 中的 datafinder cli（如 node build/domains/datafinder-interface/cli.js list / describe <id> / call <id> --params '...'），凭据已在工作目录的 .env.local。",
    "",
    "[SKILL]",
    skill,
  ];
  if (history.length) {
    lines.push("", "[本会话历史]（你与用户的前几轮，供理解追问；只作上下文，不要重复回答）：");
    for (const t of history) {
      lines.push(`用户：${t.user}`, `助手：${truncate(t.assistant, 600)}`);
    }
  }
  lines.push(
    "",
    "[当前问题]",
    query,
    "",
    "[输出要求] 最终只输出面向用户的中文结论：含关键数值、数据来源/口径、时间范围与必要注意点；不要输出执行过程旁白。若是承接上文的追问（如「那上周呢」「按 provider 拆」），结合历史理解其指代。若该问法当前不可用，如实说明并给出可用替代或下一步。",
  );
  return lines.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
