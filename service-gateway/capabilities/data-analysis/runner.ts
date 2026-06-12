import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@zed-industries/agent-client-protocol";
import type { RunnerFn, Task, TaskEventDraft } from "../../core/contracts.js";
import type { Logger } from "../../core/log.js";

export interface AcpRunnerOpts {
  cmd: string; // ACP 适配器命令，如 "npx"
  args: string[]; // 如 ["claude-code-acp"]
  cwd: string; // 仓库根（agent 工作目录）
  log: Logger;
}

/**
 * 06 · data-analysis 能力薄壳：每个 run 拉起一个 ACP agent 子进程，
 * 组装提示词 → session/prompt → 流式更新翻译为 progress / 最终回复累积为 result。
 * 权限完全开放（request_permission 一律允许）。signal → session/cancel + 终止子进程。
 */
export function createAcpRunner(opts: AcpRunnerOpts): RunnerFn {
  return async (task: Task, emit: (d: TaskEventDraft) => void, signal: AbortSignal): Promise<void> => {
    const { log } = opts;
    if (signal.aborted) return;

    // 剥掉 Claude Code 会话标记：开发期 gateway 可能本身跑在 Claude Code 里，
    // 适配器有嵌套会话检查；生产（launchd）环境本就没有这些变量
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const child = spawn(opts.cmd, opts.args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });
    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) log("debug", "runner.acp", "adapter stderr", { run_id: task.run_id, stderr: s.slice(0, 300) });
    });

    // 只保留「最后一次工具调用之后」的消息段作为最终回复——claude code 在
    // 工具调用之间也会流式输出旁白，整段累积会把执行过程当成答案发出去
    let segmentText = "";

    const client: Client = {
      async requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // 权限完全开放：优先 allow_always，其次 allow_once
        const opt =
          p.options.find((o) => o.kind === "allow_always") ??
          p.options.find((o) => o.kind === "allow_once") ??
          p.options[0];
        log("debug", "runner.acp", "permission auto-allowed", { run_id: task.run_id, option: opt?.optionId });
        if (!opt) return { outcome: { outcome: "cancelled" } };
        return { outcome: { outcome: "selected", optionId: opt.optionId } };
      },
      async sessionUpdate(n: SessionNotification): Promise<void> {
        try {
          const u = n.update;
          if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
            segmentText += u.content.text;
          } else if (u.sessionUpdate === "tool_call") {
            segmentText = ""; // 工具调用开始 → 之前的文本是旁白，重开一段
            // 用户只看「在干嘛」，不暴露命令/路径（用户反馈，2026-06-12）；原始 title 留 debug 日志排查用
            const { title, kind } = u as { title?: string; kind?: string | null };
            log("debug", "runner.acp", "tool call", { run_id: task.run_id, title: (title ?? "").slice(0, 200) });
            emit({ kind: "progress", status: describeToolKind(kind) });
          }
          // plan / available_commands_update / current_mode_update 等其余更新：忽略
        } catch (err) {
          log("warn", "runner.acp", "sessionUpdate handler error (ignored)", {
            run_id: task.run_id,
            error: String(err).slice(0, 200),
          });
        }
      },
    };

    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    const conn = new ClientSideConnection(() => client, stream);

    const killChild = (): void => {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 3000).unref();
      }
    };

    let sessionId: string | null = null;
    const onAbort = (): void => {
      log("info", "runner.acp", "cancel requested", { run_id: task.run_id });
      if (sessionId) void conn.cancel({ sessionId }).catch(() => {});
      // 协作取消给 2s，随后强制终止子进程
      setTimeout(killChild, 2000).unref();
    };
    signal.addEventListener("abort", onAbort, { once: true });

    try {
      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });
      const session = await conn.newSession({ cwd: opts.cwd, mcpServers: [] });
      sessionId = session.sessionId;
      emit({ kind: "progress", status: "正在分析…" });

      const resp = await conn.prompt({
        sessionId,
        prompt: [{ type: "text", text: buildPrompt(task) }],
      });

      if (signal.aborted || resp.stopReason === "cancelled") {
        return; // 终态由 05 runtime 补 synthetic error
      }
      if (resp.stopReason !== "end_turn") {
        emit({ kind: "error", reason: `agent 异常终止（${resp.stopReason}）`, retriable: false });
        return;
      }
      const summary = segmentText.trim();
      if (!summary) {
        emit({ kind: "error", reason: "agent 未产出回复内容", retriable: false });
        return;
      }
      emit({
        kind: "result",
        summary,
        tables: [], // M0：最终回复即结果，不做结构化拆分
        charts: [],
        artifacts_dir: `outputs/${task.run_id}`,
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
      killChild();
    }
  };
}

// persona.md 与源码同目录（不参与编译），每次 run 现读——调性格改文件即可，无需重建
const PERSONA_PATH = join(
  resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."),
  "capabilities",
  "data-analysis",
  "persona.md",
);

const EMOJI_LEARNED_PATH = join(dirname(PERSONA_PATH), "emoji-learned.md");

function loadPersona(): string {
  let text = "";
  try {
    text = readFileSync(PERSONA_PATH, "utf-8").trim();
  } catch {
    return ""; // persona 缺失不挡执行
  }
  try {
    // 机器沉淀的表情用法（learn_emoji 工具产出）存在时自动追加
    text += "\n\n" + readFileSync(EMOJI_LEARNED_PATH, "utf-8").trim();
  } catch {
    /* 还没沉淀过，正常 */
  }
  return text;
}

function buildPrompt(task: Task): string {
  return [
    loadPersona(),
    "",
    "你是数据分析执行器，按 skills/nextop-data-analytics/SKILL.md 工作。",
    "本次只允许走 dashboard 路径（已有报表查询）；禁止 raw_analysis。",
    "",
    "硬性约束（违反任何一条都是错误）：",
    "- 数据查询只能用仓库既有工具（domains/datafinder-interface/cli.py 等，凭据在 .env.local）；",
    "- 禁止安装任何依赖（pip / npm）；禁止访问外部网页或在线文档；",
    "- 工具调用失败或数据不可得时：立即停止尝试，不要修环境、不要查文档、不要换方案，",
    "  直接按下述格式回复「无法回答 + 具体失败原因」。快速诚实的失败远好于长时间无响应；",
    "- 总预算约 8 分钟，超时会被强制终止，用户只会看到一条超时报错。",
    "",
    "你的最终回复将被原样发给飞书提问者，要求：",
    "- 用中文回复，面向业务同学（不是工程师）；",
    "- 最后一条消息必须是纯回复：第一个字就是结论，禁止先写分析过程、数据提取笔记或任何英文思考再给答案；",
    "- 结论先行（一句话）→ 关键数字（markdown 表格）→ 简短口径说明；",
    "- 不要包含执行过程叙述、工具调用细节或代码。",
    "",
    `如需写文件，放在 outputs/${task.run_id}/ 目录下；`,
    `严禁创建或修改 outputs/${task.run_id}/.gateway/（网关审计目录）。`,
    "",
    "[用户问题]",
    task.input.text,
  ].join("\n");
}
