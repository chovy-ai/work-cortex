#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type Context = Record<string, any>;

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const defaultWorkflow = join(here, "workflow.json");
const defaultOutputs = join(root, "outputs");

export class StepOutcome {
  constructor(
    public status: string,
    public branch = "next",
    public contextPatch: Context = {},
    public awaitStep: string | null = null,
    public payload: Context = {},
    public message = ""
  ) {}

  static next(patch: Context = {}, branch = "next"): StepOutcome {
    return new StepOutcome("next", branch, patch);
  }

  static revise(branch: string, patch: Context = {}, message = ""): StepOutcome {
    return new StepOutcome("revise", branch, patch, null, {}, message);
  }

  static awaitInput(stepId: string, payload: Context = {}): StepOutcome {
    return new StepOutcome("await_input", "next", {}, stepId, payload);
  }

  static done(patch: Context = {}): StepOutcome {
    return new StepOutcome("done", "next", patch);
  }

  static fail(message: string, patch: Context = {}): StepOutcome {
    return new StepOutcome("failed", "next", patch, null, {}, message);
  }
}

export class SchedulerState {
  status = "running";
  revisions: Record<string, number> = {};
  awaitingStep: string | null = null;
  awaitPayload: Context = {};
  history: Context[] = [];

  constructor(
    public runId: string,
    public currentStep: string,
    public context: Context = {}
  ) {}

  apply(outcome: StepOutcome): void {
    Object.assign(this.context, outcome.contextPatch);
    this.history.push({
      status: outcome.status,
      branch: outcome.branch,
      context_patch: outcome.contextPatch,
      await_step: outcome.awaitStep,
      payload: outcome.payload,
      message: outcome.message
    });
    if (outcome.status === "await_input") {
      this.status = "awaiting_input";
      this.awaitingStep = outcome.awaitStep;
      this.awaitPayload = outcome.payload;
    } else if (outcome.status === "failed") {
      this.status = "failed";
    } else if (outcome.status === "done") {
      this.status = "completed";
    }
  }
}

interface WorkflowStep {
  id: string;
  kind: string;
  run: string;
}

interface Workflow {
  start: string;
  steps: WorkflowStep[];
  edges: Record<string, Record<string, string>>;
  backEdges?: Record<string, Record<string, string | number>>;
}

export class StepScheduler {
  readonly workflow: Workflow;
  readonly steps: Map<string, WorkflowStep>;

  constructor(
    readonly workflowPath = defaultWorkflow,
    readonly outputsDir = defaultOutputs
  ) {
    this.workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as Workflow;
    this.steps = new Map(this.workflow.steps.map((step) => [step.id, step]));
  }

  newState(context: Context = {}, runId = randomUUID().replaceAll("-", "")): SchedulerState {
    return new SchedulerState(runId, this.workflow.start, context);
  }

  persist(state: SchedulerState): string {
    const runDir = join(this.outputsDir, state.runId);
    mkdirSync(runDir, { recursive: true });
    const path = join(runDir, "state.json");
    writeFileSync(path, JSON.stringify(this.serializeState(state), null, 2) + "\n", "utf8");
    return path;
  }

  resume(runId: string): SchedulerState {
    const payload = JSON.parse(readFileSync(join(this.outputsDir, runId, "state.json"), "utf8"));
    const state = new SchedulerState(payload.run_id, payload.current_step, payload.context ?? {});
    state.status = payload.status ?? "running";
    state.revisions = payload.revisions ?? {};
    state.awaitingStep = payload.awaiting_step ?? null;
    state.awaitPayload = payload.await_payload ?? {};
    state.history = payload.history ?? [];
    return state;
  }

  async run(state: SchedulerState): Promise<SchedulerState> {
    while (state.status === "running") {
      const outcome = await this.runStep(state.currentStep, state.context);
      state.apply(outcome);
      if (state.status !== "running") {
        this.persist(state);
        return state;
      }
      state.currentStep = this.nextStep(state.currentStep, outcome, state);
      this.persist(state);
    }
    return state;
  }

  provideInput(state: SchedulerState, payload: Context): SchedulerState {
    if (state.status !== "awaiting_input") {
      throw new Error("state is not awaiting input");
    }
    state.context.user_review = payload;
    state.status = "running";
    state.awaitingStep = null;
    state.awaitPayload = {};
    return state;
  }

  async runStep(stepId: string, context: Context): Promise<StepOutcome> {
    const runner = await this.loadRunner(stepId);
    const outcome = await runner(context);
    if (!(outcome instanceof StepOutcome)) {
      throw new TypeError(`${stepId}.run(ctx) must return StepOutcome`);
    }
    return outcome;
  }

  async loadRunner(stepId: string): Promise<(ctx: Context) => StepOutcome | Promise<StepOutcome>> {
    const step = this.steps.get(stepId);
    if (!step) throw new Error(`unknown step: ${stepId}`);
    const modulePath = join(root, step.run);
    const module = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    return module.run;
  }

  nextStep(stepId: string, outcome: StepOutcome, state: SchedulerState): string {
    if (this.steps.get(stepId)?.kind === "terminal") {
      state.status = "completed";
      return stepId;
    }

    if (outcome.status === "revise") {
      const back = this.workflow.backEdges?.[stepId] ?? {};
      const target = back[outcome.branch];
      if (typeof target !== "string") {
        throw new Error(`step ${stepId} cannot revise via branch ${outcome.branch}`);
      }
      const count = (state.revisions[stepId] ?? 0) + 1;
      state.revisions[stepId] = count;
      if (count > Number(back.maxRevisions ?? 0)) {
        state.status = "failed";
        return stepId;
      }
      return target;
    }

    const branch = stepId === "route" ? state.context.query_path ?? outcome.branch : outcome.branch;
    const target = this.workflow.edges[stepId]?.[branch];
    if (!target) {
      throw new Error(`step ${stepId} has no edge for branch ${branch}`);
    }
    return target;
  }

  private serializeState(state: SchedulerState): Context {
    return {
      run_id: state.runId,
      current_step: state.currentStep,
      context: state.context,
      status: state.status,
      revisions: state.revisions,
      awaiting_step: state.awaitingStep,
      await_payload: state.awaitPayload,
      history: state.history
    };
  }
}

async function main(): Promise<number> {
  const scheduler = new StepScheduler();
  const state = scheduler.newState();
  scheduler.persist(state);
  console.log(`created scheduler state: ${state.runId}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
