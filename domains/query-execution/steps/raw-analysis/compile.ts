import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const plan = ctx.query_plan;
  if (!plan) {
    return StepOutcome.fail("raw_analysis query_plan missing");
  }
  const source = plan.raw_context?.selected_source ?? "datafinder.openapi.analysis_query";
  return StepOutcome.next({ compiled_query: { source, plan } });
}
