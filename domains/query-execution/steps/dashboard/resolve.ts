/** 4A: resolve dashboard/report asset ids. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const intent = ctx["query_intent"] ?? {};
  const slots = intent["slots"] ?? {};
  const asset_id = slots["report_id"] || slots["dashboard_id"] || ctx["asset_id"];
  if (!asset_id) {
    return StepOutcome.await_input("dashboard.resolve", { missing: "report_id or dashboard_id" });
  }
  return StepOutcome.next({ asset_id });
}
