/** 5A: build dashboard QueryPlan. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const intent = ctx["query_intent"] ?? {};
  const slots = intent["slots"] ?? {};
  const time_range = slots["time_range"] || ctx["time_range"];
  if (!ctx["asset_id"] || !time_range) {
    return StepOutcome.await_input("dashboard.plan", { missing: "asset_id or time_range" });
  }
  return StepOutcome.next({
    query_plan: {
      query_path: "dashboard",
      asset_id: ctx["asset_id"],
      time_range,
    },
  });
}
