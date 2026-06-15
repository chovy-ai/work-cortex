/**
 * 6A: 编译为可执行 CompiledQuery —— 映射到 manifest 端点 `report.query`。
 * report.query(report_id) 直接返回算好的报表数据（含时间序列），execute 负责抽成表格。
 */

import { StepOutcome } from "../../scheduler/scheduler.js";

const ENDPOINT_ID = "report.query"; // domains/datafinder-interface/manifest.json

export function run(ctx: Record<string, any>): StepOutcome {
  const plan = ctx["query_plan"];
  if (!plan) return StepOutcome.fail("dashboard compile: query_plan 缺失");
  if (!plan["report_id"]) return StepOutcome.fail("dashboard compile: report_id 缺失");

  const params: Record<string, unknown> = { report_id: plan["report_id"] };
  if (plan["app_id"] != null) params["app_id"] = plan["app_id"]; // 省略时 client 注入默认 app_id
  if (plan["count"] != null) params["count"] = plan["count"];

  return StepOutcome.next({
    compiled_query: {
      source: "datafinder.openapi.report_query",
      endpoint_id: ENDPOINT_ID,
      params,
    },
  });
}
