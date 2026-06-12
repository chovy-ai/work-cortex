/** 8B: build raw-analysis QueryPlan. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  return StepOutcome.next({
    query_plan: {
      query_path: "raw_analysis",
      intent: ctx["query_intent"] ?? {},
      raw_context: ctx["raw_context"] ?? {},
    },
  });
}
