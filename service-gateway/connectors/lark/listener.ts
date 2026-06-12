import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Envelope } from "../../core/contracts.js";
import { isValid, violationDetails } from "../../core/validate.js";
import { translate } from "./translate.js";
import type { Logger } from "../../core/log.js";

export interface ListenerHandle {
  stop(): Promise<void>;
}

export interface ListenerOpts {
  bin: string; // lark-cli 可执行名/路径
  args: string[]; // event +subscribe 参数
  onEnvelope: (env: Envelope) => void;
  log: Logger;
}

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 60_000;

/**
 * 02 · 入站 listener：托管 lark-cli 长连接子进程，stdout NDJSON 逐行 →
 * translate → schema 校验 → onEnvelope。子进程退出 → 指数退避重拉（收到事件即归零）。
 */
export function startLarkListener(opts: ListenerOpts): ListenerHandle {
  const { log } = opts;
  let child: ChildProcess | null = null;
  let stopped = false;
  let attempt = 0;
  let respawnTimer: NodeJS.Timeout | null = null;

  const launch = (): void => {
    if (stopped) return;
    log("info", "lark.listener", "starting lark-cli subscriber", { attempt });
    child = spawn(opts.bin, opts.args, { stdio: ["ignore", "pipe", "pipe"] });

    const rl = createInterface({ input: child.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        log("warn", "lark.listener", "non-JSON line skipped", { line: line.slice(0, 200) });
        return;
      }
      attempt = 0; // 收到事件，退避归零
      const env = translate(raw);
      if (!env) {
        log("debug", "lark.listener", "irrelevant event skipped");
        return;
      }
      if (!isValid("envelope", env)) {
        log("error", "lark.listener", "translate produced invalid Envelope, skipped", {
          details: violationDetails("envelope"),
        });
        return;
      }
      opts.onEnvelope(env);
    });

    child.stderr?.on("data", (d: Buffer) => {
      const s = d.toString().trim();
      if (s) log("debug", "lark.listener", "lark-cli stderr", { stderr: s.slice(0, 300) });
    });

    child.on("exit", (code, signal) => {
      child = null;
      if (stopped) return;
      attempt++;
      const delay = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
      const level = attempt > 10 ? "error" : "warn";
      log(level, "lark.listener", "lark-cli exited, respawning", { code, signal, attempt, delay_ms: delay });
      respawnTimer = setTimeout(launch, delay);
    });
  };

  launch();

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (respawnTimer) clearTimeout(respawnTimer);
      if (child) {
        const c = child;
        const exited = new Promise<void>((res) => c.once("exit", () => res()));
        c.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 3000))]);
        if (c.exitCode === null) c.kill("SIGKILL");
      }
      log("info", "lark.listener", "stopped");
    },
  };
}
