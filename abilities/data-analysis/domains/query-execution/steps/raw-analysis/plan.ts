/** 8B: raw-analysis QueryPlan —— 把 prepare 选定的数据路径 + intent + raw_context 打包给 compile。 */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const rc = ctx["raw_context"];
  if (!rc?.["data_source"]) {
    return StepOutcome.fail("raw plan: raw_context.data_source 缺失（prepare 未选定数据路径）");
  }
  return StepOutcome.next({
    query_plan: {
      query_path: "raw_analysis",
      data_source: rc["data_source"],
      intent: ctx["query_intent"] ?? {},
      raw_context: rc,
    },
  });
}
