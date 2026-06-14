/** 9B: compile raw-analysis QueryPlan. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const plan = ctx["query_plan"];
  if (!plan) {
    return StepOutcome.fail("raw_analysis query_plan missing");
  }
  const source = (plan["raw_context"] ?? {})["selected_source"] ?? "datafinder.openapi.analysis_query";
  return StepOutcome.next({ compiled_query: { source, plan } });
}
