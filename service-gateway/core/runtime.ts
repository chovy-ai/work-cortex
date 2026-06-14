import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunnerFn, Task, TaskEvent, TaskEventDraft } from "./contracts.js";
import { isValid, violationDetails } from "./validate.js";
import type { Logger } from "./log.js";

export interface RuntimeOpts {
  maxConcurrent: number;
  graceSec: number;
  outputsDir: string;
  runner: RunnerFn;
  onEvent: (ev: TaskEvent) => void;
  log: Logger;
}

interface ActiveRun {
  task: Task;
  controller: AbortController;
}

/**
 * 05 · 执行引擎 + 契约执法者。
 * 全局执行槽（FIFO 等待）；超时赛跑（abort + 宽限）；
 * emit：盖章（v/run_id/seq/at）→ ajv → events.ndjson → onEvent；
 * 终态唯一强制：缺终态补 synthetic error，终态后 emit 丢弃，违约即收尾。失败不重试。
 */
export class Runtime {
  private waitq: Task[] = [];
  private active = new Map<string, ActiveRun>();
  private idleWaiters: (() => void)[] = [];

  constructor(private opts: RuntimeOpts) {}

  submit(task: Task): void {
    this.waitq.push(task);
    this.pump();
  }

  get runningCount(): number {
    return this.active.size;
  }

  /** 优雅退出：等所有 run 终态（含等待队列清空）。 */
  idle(): Promise<void> {
    if (this.active.size === 0 && this.waitq.length === 0) return Promise.resolve();
    return new Promise((res) => this.idleWaiters.push(res));
  }

  /** 优雅退出超时 / 二次 SIGINT：放弃所有在跑 run。 */
  abortAll(reason: string): void {
    this.waitq = [];
    for (const run of this.active.values()) {
      this.opts.log("warn", "runtime", "aborting run", { run_id: run.task.run_id, reason });
      run.controller.abort();
    }
  }

  private pump(): void {
    while (this.active.size < this.opts.maxConcurrent && this.waitq.length > 0) {
      const task = this.waitq.shift()!;
      void this.exec(task);
    }
    if (this.active.size === 0 && this.waitq.length === 0) {
      const ws = this.idleWaiters;
      this.idleWaiters = [];
      for (const w of ws) w();
    }
  }

  private async exec(task: Task): Promise<void> {
    const { log, outputsDir, runner, onEvent } = this.opts;
    // 簿记放 .gateway/ 子目录：run 根目录是 agent 的工作区（权限全开的 agent
    // 会模仿/覆写根目录下的同名文件——联调实测发生过）
    const runDir = join(outputsDir, task.run_id, ".gateway");
    const controller = new AbortController();
    this.active.set(task.run_id, { task, controller });

    let seq = 0;
    let terminal = false;
    let timedOut = false;

    const persist = (ev: TaskEvent): void => {
      try {
        appendFileSync(join(runDir, "events.ndjson"), JSON.stringify(ev) + "\n");
      } catch (err) {
        log("error", "runtime", "events.ndjson append failed (not blocking)", {
          run_id: task.run_id,
          error: String(err),
        });
      }
    };

    const emit = (draft: TaskEventDraft): void => {
      if (terminal) {
        log("warn", "runtime", "emit after terminal dropped", { run_id: task.run_id, kind: draft.kind });
        return;
      }
      const ev: TaskEvent = { v: 1, run_id: task.run_id, seq: seq++, at: new Date().toISOString(), ...draft };
      if (!isValid("taskEvent", ev)) {
        const details = violationDetails("taskEvent");
        log("error", "runtime", "invalid TaskEvent from runner, failing run", { run_id: task.run_id, details });
        finishWithError(`能力产出了违约事件：${details}`);
        controller.abort();
        return;
      }
      if (ev.kind === "result" || ev.kind === "error") terminal = true;
      persist(ev);
      onEvent(ev);
    };

    const finishWithError = (reason: string): void => {
      if (terminal) return;
      const ev: TaskEvent = {
        v: 1,
        run_id: task.run_id,
        seq: seq++,
        at: new Date().toISOString(),
        kind: "error",
        reason,
        retriable: false,
      };
      terminal = true;
      persist(ev);
      onEvent(ev);
    };

    try {
      mkdirSync(runDir, { recursive: true });
      writeFileSync(join(runDir, "task.json"), JSON.stringify(task, null, 2)); // 输入快照，run 记录自包含
    } catch (err) {
      log("error", "runtime", "run dir setup failed", { run_id: task.run_id, error: String(err) });
      finishWithError(`运行目录创建失败：${String(err)}`);
      this.active.delete(task.run_id);
      this.pump();
      return;
    }

    const timeoutMs = task.limits.timeout_s * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      log("warn", "runtime", "timeout, aborting runner", { run_id: task.run_id, timeout_s: task.limits.timeout_s });
      controller.abort();
    }, timeoutMs);

    try {
      let runnerError: unknown = null;
      let settled = false;
      const guarded = runner(task, emit, controller.signal)
        .catch((err) => {
          runnerError = err;
        })
        .finally(() => {
          settled = true;
        });
      // runner 返回 / 抛错，或 abort 后宽限已尽 —— 先到者结束等待
      await Promise.race([guarded, abortedThenGrace(controller.signal, this.opts.graceSec * 1000)]);
      if (!settled) {
        log("warn", "runtime", "runner did not return within grace, abandoning", { run_id: task.run_id });
      } else if (runnerError !== null) {
        const msg = fmtErr(runnerError);
        log("error", "runtime", "runner threw", { run_id: task.run_id, error: msg });
        finishWithError(`能力执行异常：${truncate(msg, 500)}`);
      }
      if (!terminal) {
        finishWithError(timedOut ? `执行超时（${task.limits.timeout_s}s）` : "能力未产出终态事件");
      }
    } finally {
      clearTimeout(timer);
      this.active.delete(task.run_id);
      this.pump();
    }
  }
}

/** signal abort 后再等 graceMs 才 resolve；signal 不触发则永不 resolve。 */
function abortedThenGrace(signal: AbortSignal, graceMs: number): Promise<void> {
  return new Promise((res) => {
    const onAbort = () => setTimeout(res, graceMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function fmtErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null) {
    try {
      return JSON.stringify(err);
    } catch {
      /* fallthrough */
    }
  }
  return String(err);
}
