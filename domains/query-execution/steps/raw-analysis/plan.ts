import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  return StepOutcome.next({
    query_plan: {
      query_path: "raw_analysis",
      intent: ctx.query_intent ?? {},
      raw_context: ctx.raw_context ?? {}
    }
  });
}
