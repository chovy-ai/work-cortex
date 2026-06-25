/**
 * runAgentText · 自由文本 agent 入口（runStructured 的姊妹：不强制 JSON schema）。
 *
 * 给一段 prompt，经 ACP 拉起 agent（默认 claude-code）跑完，返回「最后一个工具调用之后」
 * 的最终文本。用于 skill 驱动场景：把 SKILL.md + 用户问题交给 agent，它用 Bash/cli 自取数据
 * 并产出结论。cwd 可指定（相对仓库根），让 agent 在能力工作目录里跑。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openBackendSession, type BackendDecl, type BackendSession } from "./backend.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..", ".."); // packages/atomic-abilities → packages → 仓库根

function loadBackend(id: string): BackendDecl {
  return JSON.parse(readFileSync(join(PKG_ROOT, "backends", `${id}.json`), "utf8")) as BackendDecl;
}

export interface RunAgentTextOpts {
  prompt: string;
  /** backend id，默认 "claude"。 */
  agent?: string;
  /** agent 工作目录（相对仓库根）；默认用 backend 声明的 cwd。 */
  cwd?: string;
  signal?: AbortSignal;
  /** 默认 600s。 */
  timeoutMs?: number;
}

export async function runAgentText(opts: RunAgentTextOpts): Promise<string> {
  const base = loadBackend(opts.agent ?? "claude");
  const backend: BackendDecl = opts.cwd ? { ...base, cwd: opts.cwd } : base;

  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 600_000);

  let session: BackendSession;
  try {
    session = await openBackendSession(backend, { pkgRoot: PKG_ROOT, repoRoot: REPO_ROOT, signal: ac.signal });
  } catch (err) {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
    throw err;
  }
  try {
    return await session.prompt(opts.prompt);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
    session.close();
  }
}
