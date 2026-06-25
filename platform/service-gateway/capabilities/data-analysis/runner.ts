import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgentText } from "atomic-abilities";
import type { RunnerFn, Task, TaskEventDraft } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";

export interface SkillRunnerOpts {
  /** 分析能力本体根目录（含 build/、skills/、.env.local）。 */
  abilityRoot: string;
  /** agent 工作目录，相对仓库根（agent 在此跑 cli、读 .env.local）。 */
  abilityRelCwd: string;
  log: Logger;
}

/**
 * 06 · data-analysis 能力：skill 驱动。
 *
 * 不再用确定性 step 图，而是拉起一个 ACP agent（claude-code），喂它 data-analytics SKILL +
 * 用户问题，让它在能力工作目录里用 datafinder cli 自取数据、产出结论。SKILL 决定方法论
 * （看板复用 / 自由分析），agent 用 Bash 跑 cli。最终文本即回复。
 */
export function createSkillRunner(opts: SkillRunnerOpts): RunnerFn {
  const { abilityRoot, abilityRelCwd, log } = opts;
  let skill = "";
  try {
    skill = readFileSync(join(abilityRoot, "skills", "data-analytics", "SKILL.md"), "utf-8");
  } catch (err) {
    log("warn", "runner.skill", "SKILL.md 读取失败（agent 将无技能上下文）", { error: String(err).slice(0, 200) });
  }

  return async (task: Task, emit: (d: TaskEventDraft) => void, signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return;
    emit({ kind: "progress", status: "正在分析…" });

    const prompt = buildPrompt(skill, task.input.text);
    try {
      const answer = await runAgentText({
        prompt,
        cwd: abilityRelCwd,
        signal,
        timeoutMs: task.limits.timeout_s * 1000,
      });
      if (signal.aborted) return; // 终态由 runtime 补
      emit({ kind: "result", summary: answer.trim() || "（分析完成，但没有产出可读结论）", tables: [], charts: [] });
    } catch (err) {
      log("error", "runner.skill", "agent 执行失败", { run_id: task.run_id, error: String(err).slice(0, 300) });
      emit({ kind: "error", reason: `分析失败：${truncate(String(err), 200)}`, retriable: false });
    }
  };
}

function buildPrompt(skill: string, query: string): string {
  return [
    "你是数据分析助手。下面是你的技能说明（SKILL），请严格据此回答用户问题。",
    "你可以用 Bash 运行 SKILL 中的 datafinder cli（如 node build/domains/datafinder-interface/cli.js list / describe <id> / call <id> --params '...'），凭据已在工作目录的 .env.local。",
    "",
    "[SKILL]",
    skill,
    "",
    "[用户问题]",
    query,
    "",
    "[输出要求] 最终只输出面向用户的中文结论：含关键数值、数据来源/口径、时间范围与必要注意点；不要输出执行过程旁白。若该问法当前不可用（如自由分析 analysis.query 受限），如实说明并给出可用替代（看板复用）或下一步。",
  ].join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
