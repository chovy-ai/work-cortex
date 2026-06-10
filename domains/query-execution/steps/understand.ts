import { StepOutcome, type Context } from "../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const intent = { ...(ctx.query_intent ?? {}) };
  if (Object.keys(intent).length === 0) {
    intent.query_path = ctx.query_path ?? "raw_analysis";
    intent.warnings = ["QueryIntent must be produced from domains/intent-routing protocols before execution."];
  }
  const queryPath = intent.query_path ?? "raw_analysis";
  return StepOutcome.next({ query_intent: intent, query_path: queryPath });
}
