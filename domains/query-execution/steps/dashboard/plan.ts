import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const slots = ctx.query_intent?.slots ?? {};
  const timeRange = slots.time_range ?? ctx.time_range;
  if (!ctx.asset_id || !timeRange) {
    return StepOutcome.awaitInput("dashboard.plan", { missing: "asset_id or time_range" });
  }
  return StepOutcome.next({
    query_plan: {
      query_path: "dashboard",
      asset_id: ctx.asset_id,
      time_range: timeRange
    }
  });
}
