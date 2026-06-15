/** 5A: 组装 dashboard QueryPlan（report_id + app_id + 可选 count）。 */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const slots = (ctx["query_intent"] ?? {})["slots"] ?? {};
  const report_id = ctx["asset_id"] ?? slots["report_id"];
  if (!report_id) {
    return StepOutcome.await_input("dashboard.plan", { missing: "report_id" });
  }
  return StepOutcome.next({
    query_plan: {
      query_path: "dashboard",
      report_id,
      app_id: ctx["app_id"] ?? slots["app_id"],
      count: slots["count"],
    },
  });
}
