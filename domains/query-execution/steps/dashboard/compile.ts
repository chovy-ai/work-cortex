import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const plan = ctx.query_plan;
  if (!plan) {
    return StepOutcome.fail("dashboard query_plan missing");
  }
  return StepOutcome.next({
    compiled_query: {
      source: "datafinder.openapi.report_query",
      request: {
        asset_id: plan.asset_id,
        time_range: plan.time_range
      }
    }
  });
}
