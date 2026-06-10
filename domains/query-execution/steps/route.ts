import { StepOutcome, type Context } from "../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const queryPath = ctx.query_path ?? ctx.query_intent?.query_path;
  if (queryPath !== "dashboard" && queryPath !== "raw_analysis") {
    return StepOutcome.fail(`unsupported query_path: ${queryPath}`);
  }
  return StepOutcome.next({ query_path: queryPath }, queryPath);
}
