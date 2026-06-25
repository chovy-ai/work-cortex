/**
 * 7A: 真正执行 —— 经 datafinder-access 门面调 manifest 端点（report.query），
 * 门面统一做错误归一与响应抽表（report.query 的数据在 data.dsls[0].data[].data_item_list[]）。
 */

import { StepOutcome } from "../../scheduler/scheduler.js";
import { dataFinder } from "../../../datafinder-interface/index.js";

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const compiled = ctx["compiled_query"];
  if (!compiled?.["endpoint_id"]) {
    return StepOutcome.fail("dashboard execute: compiled_query.endpoint_id 缺失");
  }
  const compiled_id = `${ctx["run_id"] ?? "adhoc"}:${compiled["endpoint_id"]}`;

  const r = await dataFinder().call(compiled["endpoint_id"], (compiled["params"] ?? {}) as Record<string, unknown>);
  const execution_result = r.ok
    ? { status: "success", compiled_id, execution_kind: "openapi", result: r.result, warnings: r.warnings }
    : {
        status: "error",
        compiled_id,
        execution_kind: "openapi",
        error: { code: r.code, message: r.message, retryable: r.retryable },
        warnings: r.warnings,
      };
  return StepOutcome.next({ execution_result });
}
