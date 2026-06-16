import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Runtime } from "../core/runtime.js";
import { silentLogger } from "../core/log.js";
import type { RunnerFn, Task, TaskEvent } from "../core/contracts.js";

function task(id: string, timeoutS = 5): Task {
  return {
    v: 1,
    run_id: id,
    capability: "data-analysis",
    input: { text: "q" },
    context: { principal: { member: "u" }, conversation_ref: "ref", history: [] },
    resume: null,
    limits: { timeout_s: timeoutS },
  };
}

function harness(runner: RunnerFn, maxConcurrent = 1, graceSec = 0.1) {
  const events: TaskEvent[] = [];
  const outputsDir = mkdtempSync(join(tmpdir(), "sg-rt-"));
  const rt = new Runtime({
    maxConcurrent,
    graceSec,
    outputsDir,
    runner,
    onEvent: (e) => events.push(e),
    log: silentLogger,
  });
  return { rt, events, outputsDir };
}

test("normal run: result delivered, task.json + events.ndjson persisted, seq monotonic", async () => {
  const { rt, events, outputsDir } = harness(async (t, emit) => {
    emit({ kind: "progress", status: "working" });
    emit({ kind: "result", summary: "答案", tables: [], charts: [] });
  });
  rt.submit(task("run_ok"));
  await rt.idle();
  assert.deepEqual(events.map((e) => e.kind), ["progress", "result"]);
  assert.deepEqual(events.map((e) => e.seq), [0, 1]);
  assert.ok(existsSync(join(outputsDir, "run_ok", ".gateway", "task.json")));
  const lines = readFileSync(join(outputsDir, "run_ok", ".gateway", "events.ndjson"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("runner returns without terminal → synthetic error", async () => {
  const { rt, events } = harness(async (_t, emit) => {
    emit({ kind: "progress", status: "..." });
  });
  rt.submit(task("run_silent"));
  await rt.idle();
  const last = events.at(-1)!;
  assert.equal(last.kind, "error");
  assert.match((last as { reason: string }).reason, /未产出终态/);
});

test("runner throws → synthetic error", async () => {
  const { rt, events } = harness(async () => {
    throw new Error("boom");
  });
  rt.submit(task("run_throw"));
  await rt.idle();
  assert.equal(events.at(-1)!.kind, "error");
  assert.match((events.at(-1) as { reason: string }).reason, /boom/);
});

test("emit after terminal is dropped", async () => {
  const { rt, events } = harness(async (_t, emit) => {
    emit({ kind: "result", summary: "ok", tables: [], charts: [] });
    emit({ kind: "progress", status: "late" }); // 应被丢弃
  });
  rt.submit(task("run_late"));
  await rt.idle();
  assert.deepEqual(events.map((e) => e.kind), ["result"]);
});

test("invalid event from runner → run fails with synthetic error", async () => {
  const { rt, events } = harness(async (_t, emit) => {
    emit({ kind: "progress" } as never); // 缺 status，违约
    await new Promise((r) => setTimeout(r, 50));
  });
  rt.submit(task("run_bad"));
  await rt.idle();
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "error");
  assert.match((events[0] as { reason: string }).reason, /违约/);
});

test("timeout: abort signal fires, run ends with timeout error", async () => {
  let aborted = false;
  const { rt, events } = harness(async (_t, _emit, signal) => {
    await new Promise<void>((res) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        res();
      });
    });
  });
  rt.submit(task("run_slow", 1)); // 1s 超时
  await rt.idle();
  assert.equal(aborted, true);
  assert.equal(events.at(-1)!.kind, "error");
  assert.match((events.at(-1) as { reason: string }).reason, /超时/);
});

test("concurrency cap: maxConcurrent=1 serializes runs", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { rt } = harness(async (_t, emit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    emit({ kind: "result", summary: "ok", tables: [], charts: [] });
  }, 1);
  rt.submit(task("r1"));
  rt.submit(task("r2"));
  rt.submit(task("r3"));
  await rt.idle();
  assert.equal(maxInFlight, 1);
});
