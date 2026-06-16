import { spawn } from "node:child_process";
import { resolve } from "node:path";
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
import { AbilityAbortError, AbilityRuntimeError } from "./errors.js";

/**
 * agent 适配器声明（内部约定，非对外契约）。
 * 提炼自 service-gateway/capabilities/data-analysis/runner.ts 的 ACP 调用，
 * 把硬编码的 claude-code 参数化为「由 backend 声明决定」。
 */
export interface BackendDecl {
  id: string;
  transport: "acp";
  cmd: string; // 含 "/" 按相对包根解析；否则走 PATH（如 npx）
  args?: string[];
  cwd?: string; // 相对仓库根，agent 工作目录；默认 "."
  env_strip?: string[]; // 剥离的环境变量（如 CLAUDECODE 嵌套会话标记）
  permission?: "allow_all";
}

export interface OpenOpts {
  pkgRoot: string; // 解析相对 cmd
  repoRoot: string; // 解析相对 cwd
  signal: AbortSignal; // 取消 / 超时
}

/** 一个已建会话的 backend：可多轮 prompt（供 revise 复用上下文），close 清理子进程。 */
export interface BackendSession {
  prompt(text: string): Promise<string>;
  close(): void;
}

/**
 * 拉起 backend 的 ACP 子进程并建会话。权限完全开放（request_permission 一律放行）。
 * prompt() 返回「最后一个工具调用之后」的消息段——agent 在工具调用间也会流式输出
 * 旁白，整段累积会把执行过程当成答案。signal abort → session/cancel + 终止子进程。
 */
export async function openBackendSession(backend: BackendDecl, opts: OpenOpts): Promise<BackendSession> {
  const { signal } = opts;
  if (signal.aborted) throw new AbilityAbortError("aborted before backend start");

  const env = { ...process.env };
  for (const k of backend.env_strip ?? []) delete env[k];

  const cmd = backend.cmd.includes("/") ? resolve(opts.pkgRoot, backend.cmd) : backend.cmd;
  const cwd = resolve(opts.repoRoot, backend.cwd ?? ".");
  const child = spawn(cmd, backend.args ?? [], { cwd, stdio: ["pipe", "pipe", "pipe"], env });

  // 只保留「最后一次工具调用之后」的消息段作为最终回复
  let segmentText = "";

  const client: Client = {
    async requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
      const opt =
        p.options.find((o) => o.kind === "allow_always") ??
        p.options.find((o) => o.kind === "allow_once") ??
        p.options[0];
      if (!opt) return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: opt.optionId } };
    },
    async sessionUpdate(n: SessionNotification): Promise<void> {
      const u = n.update;
      if (u.sessionUpdate === "agent_message_chunk" && u.content.type === "text") {
        segmentText += u.content.text;
      } else if (u.sessionUpdate === "tool_call") {
        segmentText = ""; // 工具调用开始 → 之前的文本是旁白，重开一段
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
    if (sessionId) void conn.cancel({ sessionId }).catch(() => {});
    setTimeout(killChild, 2000).unref();
  };
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    });
    const session = await conn.newSession({ cwd, mcpServers: [] });
    sessionId = session.sessionId;
  } catch (err) {
    signal.removeEventListener("abort", onAbort);
    killChild();
    throw new AbilityRuntimeError(`backend ${backend.id} 启动失败：${fmtErr(err)}`);
  }

  return {
    async prompt(text: string): Promise<string> {
      if (signal.aborted) throw new AbilityAbortError("aborted");
      segmentText = "";
      const resp = await conn.prompt({ sessionId: sessionId!, prompt: [{ type: "text", text }] });
      if (signal.aborted || resp.stopReason === "cancelled") throw new AbilityAbortError("aborted");
      if (resp.stopReason !== "end_turn") {
        throw new AbilityRuntimeError(`agent 异常终止（${resp.stopReason}）`);
      }
      return segmentText.trim();
    },
    close(): void {
      signal.removeEventListener("abort", onAbort);
      killChild();
    },
  };
}

function fmtErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
