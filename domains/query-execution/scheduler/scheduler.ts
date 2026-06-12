#!/usr/bin/env node
/** Declarative query-execution scheduler. */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Paths are computed from the compiled location of this module:
// build/domains/query-execution/scheduler/scheduler.js
//   - repo root  = four levels up from this directory
//   - build root = three levels up (compiled step modules live there)
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..", "..");
const BUILD_ROOT = path.resolve(HERE, "..", "..", "..");
const WORKFLOW = path.join(ROOT, "domains", "query-execution", "scheduler", "workflow.json");
const OUTPUTS = path.join(ROOT, "outputs");

export interface StepOutcomeInit {
  status: string;
  branch?: string;
  context_patch?: Record<string, any>;
  await_step?: string | null;
  payload?: Record<string, any>;
  message?: string;
}

export class StepOutcome {
  status: string;
  branch: string;
  context_patch: Record<string, any>;
  await_step: string | null;
  payload: Record<string, any>;
  message: string;

  constructor(init: StepOutcomeInit) {
    this.status = init.status;
    this.branch = init.branch ?? "next";
    this.context_patch = init.context_patch ?? {};
    this.await_step = init.await_step ?? null;
    this.payload = init.payload ?? {};
    this.message = init.message ?? "";
  }

  static next(patch: Record<string, any> | null = null, branch = "next"): StepOutcome {
    return new StepOutcome({ status: "next", branch, context_patch: patch ?? {} });
  }

  static revise(branch: string, patch: Record<string, any> | null = null, message = ""): StepOutcome {
    return new StepOutcome({ status: "revise", branch, context_patch: patch ?? {}, message });
  }

  static await_input(step_id: string, payload: Record<string, any> | null = null): StepOutcome {
    return new StepOutcome({ status: "await_input", await_step: step_id, payload: payload ?? {} });
  }

  static done(patch: Record<string, any> | null = null): StepOutcome {
    return new StepOutcome({ status: "done", context_patch: patch ?? {} });
  }

  static fail(message: string, patch: Record<string, any> | null = null): StepOutcome {
    return new StepOutcome({ status: "failed", context_patch: patch ?? {}, message });
  }
}

export interface SchedulerStateInit {
  run_id: string;
  current_step: string;
  context?: Record<string, any>;
  status?: string;
  revisions?: Record<string, number>;
  awaiting_step?: string | null;
  await_payload?: Record<string, any>;
  history?: Record<string, any>[];
}

export class SchedulerState {
  run_id: string;
  current_step: string;
  context: Record<string, any>;
  status: string;
  revisions: Record<string, number>;
  awaiting_step: string | null;
  await_payload: Record<string, any>;
  history: Record<string, any>[];

  constructor(init: SchedulerStateInit) {
    this.run_id = init.run_id;
    this.current_step = init.current_step;
    this.context = init.context ?? {};
    this.status = init.status ?? "running";
    this.revisions = init.revisions ?? {};
    this.awaiting_step = init.awaiting_step ?? null;
    this.await_payload = init.await_payload ?? {};
    this.history = init.history ?? [];
  }

  apply(outcome: StepOutcome): void {
    Object.assign(this.context, outcome.context_patch);
    this.history.push({ ...outcome });
    if (outcome.status === "await_input") {
      this.status = "awaiting_input";
      this.awaiting_step = outcome.await_step;
      this.await_payload = outcome.payload;
    } else if (outcome.status === "failed") {
      this.status = "failed";
    } else if (outcome.status === "done") {
      this.status = "completed";
    }
  }
}

export interface WorkflowStep {
  id: string;
  kind?: string;
  run: string;
}

export interface Workflow {
  start: string;
  steps: WorkflowStep[];
  edges?: Record<string, Record<string, string>>;
  backEdges?: Record<string, Record<string, string | number>>;
  [key: string]: any;
}

export type StepRunner = (ctx: Record<string, any>) => StepOutcome;

export class StepScheduler {
  workflow_path: string;
  outputs_dir: string;
  workflow: Workflow;
  steps: Record<string, WorkflowStep>;

  constructor(workflow_path: string = WORKFLOW, outputs_dir: string = OUTPUTS) {
    this.workflow_path = workflow_path;
    this.outputs_dir = outputs_dir;
    this.workflow = JSON.parse(readFileSync(workflow_path, "utf-8")) as Workflow;
    this.steps = {};
    for (const step of this.workflow.steps) {
      this.steps[step.id] = step;
    }
  }

  new_state(context: Record<string, any> | null = null, run_id: string | null = null): SchedulerState {
    return new SchedulerState({
      run_id: run_id ?? randomUUID().replaceAll("-", ""),
      current_step: this.workflow.start,
      context: context ?? {},
    });
  }

  persist(state: SchedulerState): string {
    const run_dir = path.join(this.outputs_dir, state.run_id);
    mkdirSync(run_dir, { recursive: true });
    const file = path.join(run_dir, "state.json");
    writeFileSync(file, JSON.stringify(state, null, 2) + "\n", "utf-8");
    return file;
  }

  resume(run_id: string): SchedulerState {
    const file = path.join(this.outputs_dir, run_id, "state.json");
    const payload = JSON.parse(readFileSync(file, "utf-8")) as SchedulerStateInit;
    return new SchedulerState(payload);
  }

  async run(state: SchedulerState): Promise<SchedulerState> {
    while (state.status === "running") {
      const outcome = await this._run_step(state.current_step, state.context);
      state.apply(outcome);
      if (state.status !== "running") {
        this.persist(state);
        return state;
      }
      state.current_step = this._next_step(state.current_step, outcome, state);
      this.persist(state);
    }
    return state;
  }

  provide_input(state: SchedulerState, payload: Record<string, any>): SchedulerState {
    if (state.status !== "awaiting_input") {
      throw new Error("state is not awaiting input");
    }
    state.context["user_review"] = payload;
    state.status = "running";
    state.awaiting_step = null;
    state.await_payload = {};
    return state;
  }

  private async _run_step(step_id: string, context: Record<string, any>): Promise<StepOutcome> {
    const runner = await this._load_runner(step_id);
    const outcome = runner(context);
    if (!(outcome instanceof StepOutcome)) {
      throw new TypeError(`${step_id}.run(ctx) must return StepOutcome`);
    }
    return outcome;
  }

  private async _load_runner(step_id: string): Promise<StepRunner> {
    const step = this.steps[step_id];
    // workflow.json declares the Python source path of each step; load the
    // compiled .js module from the build tree instead.
    const modulePath = path.join(BUILD_ROOT, step.run.replace(/\.(py|ts)$/, ".js"));
    let module: { run?: StepRunner };
    try {
      module = await import(pathToFileURL(modulePath).href);
    } catch (exc) {
      if ((exc as NodeJS.ErrnoException)?.code === "ERR_MODULE_NOT_FOUND") {
        throw new Error(`cannot load step ${step_id} from ${modulePath}`);
      }
      throw exc;
    }
    if (typeof module.run !== "function") {
      throw new TypeError(`step ${step_id} module at ${modulePath} has no run(ctx) function`);
    }
    return module.run;
  }

  private _next_step(step_id: string, outcome: StepOutcome, state: SchedulerState): string {
    if (this.steps[step_id].kind === "terminal") {
      state.status = "completed";
      return step_id;
    }

    if (outcome.status === "revise") {
      const back = (this.workflow.backEdges ?? {})[step_id] ?? {};
      const target = back[outcome.branch];
      if (target === undefined || target === null) {
        throw new Error(`step ${step_id} cannot revise via branch ${outcome.branch}`);
      }
      const count = (state.revisions[step_id] ?? 0) + 1;
      state.revisions[step_id] = count;
      if (count > Number(back["maxRevisions"] ?? 0)) {
        state.status = "failed";
        return step_id;
      }
      return String(target);
    }

    let branch = outcome.branch;
    if (step_id === "route") {
      branch = "query_path" in state.context ? state.context["query_path"] : branch;
    }
    const target = ((this.workflow.edges ?? {})[step_id] ?? {})[branch];
    if (target === undefined || target === null) {
      throw new Error(`step ${step_id} has no edge for branch ${branch}`);
    }
    return target;
  }
}

async function main(): Promise<number> {
  const scheduler = new StepScheduler();
  const state = scheduler.new_state();
  scheduler.persist(state);
  console.log(`created scheduler state: ${state.run_id}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
