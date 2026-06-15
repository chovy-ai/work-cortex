/** 4A: 解析报表资产——从 QueryIntent.slots 取 report_id / app_id；缺 report_id 则挂起等输入。 */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const slots = (ctx["query_intent"] ?? {})["slots"] ?? {};
  const report_id = slots["report_id"] ?? ctx["asset_id"];
  if (!report_id) {
    return StepOutcome.await_input("dashboard.resolve", { missing: "report_id" });
  }
  return StepOutcome.next({ asset_id: report_id, app_id: slots["app_id"] });
}
