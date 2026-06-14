/** 7A: execute dashboard query placeholder. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const compiled = ctx["compiled_query"];
  if (!compiled) {
    return StepOutcome.fail("dashboard compiled_query missing");
  }
  return StepOutcome.next({
    execution_result: {
      status: "not_executed",
      source: compiled["source"],
      reason: "DataFinder credentials/live call are handled by domains/datafinder-interface/client.py.",
    },
  });
}
