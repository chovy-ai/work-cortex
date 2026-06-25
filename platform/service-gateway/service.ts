import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createLogger, type LogLevel } from "./core/log.js";
import { EnvelopeQueue } from "./core/queue.js";
import { Sessions } from "./core/sessions.js";
import { Runtime } from "./core/runtime.js";
import { startLarkListener } from "./connectors/lark/listener.js";
import { LarkSender } from "./connectors/lark/sender.js";
import { ConsoleSender } from "./connectors/console/sender.js";
import { startConsoleHttp, type ConsoleHttpHandle } from "./connectors/console/http.js";
import { createSchedulerRunner } from "./capabilities/data-analysis/runner.js";

const execFileP = promisify(execFile);

// dist/service.js → 包根（platform/service-gateway）→ platform → 仓库根
const sgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(sgRoot, "..", "..");
// 分析能力本体：agent 工作目录，outputs/ 与 knowledge-store/ 都在这里
const abilityRoot = join(repoRoot, "abilities", "data-analysis");

interface Config {
  runtime: { maxConcurrent: number; timeoutSec: number; graceSec: number };
  queue: { maxSize: number; dedupCapacity: number };
  sessions: { pendingPerConversation: number; terminalKeep: number };
  capability: { id: string };
  lark: { bin: string; subscribeArgs: string[] };
  console: { enabled: boolean; host: string; port: number };
  log: { level: LogLevel };
}

const DEFAULTS: Config = {
  runtime: { maxConcurrent: 1, timeoutSec: 600, graceSec: 10 },
  queue: { maxSize: 1000, dedupCapacity: 4096 },
  sessions: { pendingPerConversation: 10, terminalKeep: 512 },
  capability: { id: "data-analysis" },
  lark: { bin: "lark-cli", subscribeArgs: ["event", "+subscribe", "--as", "bot", "--event-types", "im.message.receive_v1,card.action.trigger", "--quiet"] },
  // 控制台入站：本机回环 HTTP，供 gateway-console GUI 直接提交查询（结果走文件系统呈现）
  console: { enabled: true, host: "127.0.0.1", port: 8765 },
  log: { level: "info" },
};

function loadConfig(): Config {
  const file = join(sgRoot, "config.json");
  let user: Partial<Config> = {};
  if (existsSync(file)) user = JSON.parse(readFileSync(file, "utf8"));
  const cfg: Config = {
    runtime: { ...DEFAULTS.runtime, ...user.runtime },
    queue: { ...DEFAULTS.queue, ...user.queue },
    sessions: { ...DEFAULTS.sessions, ...user.sessions },
    capability: { ...DEFAULTS.capability, ...user.capability },
    lark: { ...DEFAULTS.lark, ...user.lark },
    console: { ...DEFAULTS.console, ...user.console },
    log: { ...DEFAULTS.log, ...user.log },
  };
  // 环境变量单项覆盖
  if (process.env.SG_MAX_CONCURRENT) cfg.runtime.maxConcurrent = Number(process.env.SG_MAX_CONCURRENT);
  if (process.env.SG_TIMEOUT_S) cfg.runtime.timeoutSec = Number(process.env.SG_TIMEOUT_S);
  if (process.env.SG_CONSOLE_PORT) cfg.console.port = Number(process.env.SG_CONSOLE_PORT);
  if (process.env.SG_CONSOLE_ENABLED) cfg.console.enabled = process.env.SG_CONSOLE_ENABLED !== "0";
  if (process.env.SG_LOG_LEVEL) cfg.log.level = process.env.SG_LOG_LEVEL as LogLevel;
  return cfg;
}

async function preflight(cfg: Config, log: ReturnType<typeof createLogger>): Promise<void> {
  const fail = (msg: string, hint: string): never => {
    log("error", "service", `preflight failed: ${msg}`, { hint });
    process.exit(1);
  };

  // outputs 可写
  try {
    mkdirSync(join(abilityRoot, "outputs"), { recursive: true });
  } catch (err) {
    fail(`outputs/ 不可写：${String(err)}`, "检查仓库目录权限");
  }

  // 分析引擎已编译（runner 进程内 import build 产物）
  if (!existsSync(join(abilityRoot, "build", "domains", "query-execution", "scheduler", "scheduler.js"))) {
    fail("分析引擎未编译（build/ 缺失）", "在仓库根运行 npm run build:ability");
  }

  // 知识库存在（M0 知识更新是手动前置）
  if (!existsSync(join(abilityRoot, "knowledge-store", "event-catalog.json"))) {
    fail(
      "knowledge-store/event-catalog.json 缺失",
      "先跑知识更新：domains/event-knowledge 的 sync + extract（见 ARCHITECTURE.md）",
    );
  }

  // lark-cli 可用。M0 全链路用 bot 身份，因此只硬性要求 app 凭据与端点可达；
  // 用户 token 过期（token_local）只警告——它不影响 bot 收发，doctor 却会因此非零退出。
  if (process.env.SG_SKIP_DOCTOR === "1") {
    log("warn", "service", "lark-cli doctor skipped (SG_SKIP_DOCTOR=1)");
  } else {
    const REQUIRED = new Set(["config_file", "app_resolved", "endpoint_open"]);
    let stdout = "";
    try {
      ({ stdout } = await execFileP(cfg.lark.bin, ["doctor"], { timeout: 30_000 }));
    } catch (err) {
      stdout = (err as { stdout?: string }).stdout ?? "";
      if (!stdout) {
        fail(`lark-cli doctor 无法执行：${String(err).slice(0, 300)}`, "确认 lark-cli 已安装且在 PATH；或 SG_SKIP_DOCTOR=1 跳过");
      }
    }
    try {
      const checks: { name: string; status: string; message?: string }[] = JSON.parse(stdout).checks ?? [];
      for (const c of checks) {
        if (c.status === "pass") continue;
        if (REQUIRED.has(c.name)) {
          fail(`lark-cli 检查未通过：${c.name}（${c.message ?? ""}）`, "运行 lark-cli doctor 排查凭据/网络");
        } else {
          log("warn", "service", `lark-cli check ${c.status}: ${c.name}`, { message: c.message?.slice(0, 150) });
        }
      }
    } catch {
      fail("lark-cli doctor 输出无法解析", "手动运行 lark-cli doctor 检查；或 SG_SKIP_DOCTOR=1 跳过");
    }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = createLogger(cfg.log.level);
  log("info", "service", "starting", { sgRoot, repoRoot, abilityRoot, maxConcurrent: cfg.runtime.maxConcurrent });

  await preflight(cfg, log);

  // 组装（依赖序）：queue → sender → runtime → sessions，回流经闭包后绑定
  const queue = new EnvelopeQueue(cfg.queue, log);
  const sender = new LarkSender({ bin: cfg.lark.bin, log });
  const consoleSender = new ConsoleSender(log);
  // 进程内驱动分析能力的声明式调度器（build 产物在 abilityRoot/build/ 下）
  const runner = createSchedulerRunner({ abilityRoot, log });
  let sessions: Sessions;
  const runtime = new Runtime({
    maxConcurrent: cfg.runtime.maxConcurrent,
    graceSec: cfg.runtime.graceSec,
    outputsDir: join(abilityRoot, "outputs"),
    runner,
    onEvent: (ev) => sessions.handleEvent(ev),
    log,
  });
  sessions = new Sessions({
    capabilityId: cfg.capability.id,
    timeoutSec: cfg.runtime.timeoutSec,
    pendingLimit: cfg.sessions.pendingPerConversation,
    terminalKeep: cfg.sessions.terminalKeep,
    submit: (t) => runtime.submit(t),
    sender,
    senderByChannel: { console: consoleSender },
    log,
  });

  const listener = startLarkListener({
    bin: cfg.lark.bin,
    args: cfg.lark.subscribeArgs,
    onEnvelope: (env) => queue.push(env),
    log,
  });

  // 控制台入站：本机回环 HTTP，GUI 提交查询入同一队列（结果走文件系统回显）
  let consoleHttp: ConsoleHttpHandle | null = null;
  if (cfg.console.enabled) {
    consoleHttp = startConsoleHttp({
      host: cfg.console.host,
      port: cfg.console.port,
      push: (env) => queue.push(env),
      status: () => ({ queue: queue.size, running: sessions.runningCount }),
      log,
    });
  }

  // 退出序：停 listener → 排空 queue → 等 running ≤30s → abort → exit
  let shuttingDown = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (shuttingDown) {
      log("warn", "service", "second signal, aborting immediately");
      runtime.abortAll("forced shutdown");
      process.exit(1);
    }
    shuttingDown = true;
    log("info", "service", `${sig} received, graceful shutdown`);
    await Promise.all([listener.stop(), consoleHttp?.stop() ?? Promise.resolve()]);
    queue.stop();
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log("info", "service", "ready, consuming envelopes");
  for await (const env of queue.consume()) {
    sessions.handleEnvelope(env);
  }

  // queue 已排空，等 running run 自然完成（上限 30s）
  log("info", "service", "queue drained, waiting for running runs (≤30s)");
  const timeout = new Promise<"timeout">((res) => setTimeout(() => res("timeout"), 30_000));
  const result = await Promise.race([runtime.idle().then(() => "idle" as const), timeout]);
  if (result === "timeout") {
    log("warn", "service", "graceful wait timed out, aborting remaining runs");
    runtime.abortAll("shutdown timeout");
    await Promise.race([runtime.idle(), new Promise((res) => setTimeout(res, 5000))]);
  }
  log("info", "service", "bye");
  process.exit(0);
}

// 适配器/第三方库的异步垃圾不应杀死网关：未处理 rejection 记日志放行
// （受影响的 run 会走超时 → synthetic error）；同步未捕获异常仍退出交给 launchd 重拉。
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`unhandledRejection (run continues): ${String(reason).slice(0, 500)}\n`);
});
process.on("uncaughtException", (err) => {
  process.stderr.write(`uncaughtException, exiting: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});

main().catch((err) => {
  // 启动失败：记日志后非零退出，launchd KeepAlive 重拉
  process.stderr.write(`fatal: ${err?.stack ?? String(err)}\n`);
  process.exit(1);
});
