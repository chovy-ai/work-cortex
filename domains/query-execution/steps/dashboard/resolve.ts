import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const slots = ctx.query_intent?.slots ?? {};
  const assetId = slots.report_id ?? slots.dashboard_id ?? ctx.asset_id;
  if (!assetId) {
    return StepOutcome.awaitInput("dashboard.resolve", { missing: "report_id or dashboard_id" });
  }
  return StepOutcome.next({ asset_id: assetId });
}
