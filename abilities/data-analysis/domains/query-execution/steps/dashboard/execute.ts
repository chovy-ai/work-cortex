/**
 * 7A: 真正执行 —— 用 DataFinderClient 调 manifest 端点，APIResult → ExecutionResult。
 * report.query 的真实数据藏在 data.dsls[0].data[].data_item_list[]（每条指标一组时间序列），
 * normalizeReportData 把它抽成「date × 各指标」的表格；抽不出再退回通用包装。
 */

import { StepOutcome } from "../../scheduler/scheduler.js";
import { DataFinderClient, loadConfigFromEnv, type APIResult } from "../../../datafinder-interface/client.js";

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const compiled = ctx["compiled_query"];
  if (!compiled?.["endpoint_id"]) {
    return StepOutcome.fail("dashboard execute: compiled_query.endpoint_id 缺失");
  }
  const compiled_id = `${ctx["run_id"] ?? "adhoc"}:${compiled["endpoint_id"]}`;

  let client: DataFinderClient;
  try {
    client = new DataFinderClient(loadConfigFromEnv());
  } catch (err) {
    return StepOutcome.next({
      execution_result: errorResult(compiled_id, "openapi_auth_failed", `DataFinder 配置加载失败：${String(err)}`),
    });
  }

  const res = await client.call(compiled["endpoint_id"], (compiled["params"] ?? {}) as Record<string, unknown>);
  return StepOutcome.next({ execution_result: toExecutionResult(compiled_id, res) });
}

function toExecutionResult(compiled_id: string, res: APIResult): Record<string, any> {
  if (res.status === "success") {
    const result = normalizeReportData(res.data) ?? genericResult(res.data);
    return { status: "success", compiled_id, execution_kind: "openapi", result, warnings: res.warnings ?? [] };
  }
  return errorResult(compiled_id, mapErrorCode(res.error_code), res.error_message ?? "unknown error", res.warnings);
}

/** report.query 报表数据 → { date, 指标1, 指标2... } 表格。抽不出返回 null。 */
function normalizeReportData(data: any): Record<string, any> | null {
  const series: any[] | undefined = data?.dsls?.[0]?.data;
  if (!Array.isArray(series)) return null;
  const s = series.find((x) => Array.isArray(x?.data_item_list) && x.data_item_list.length > 0);
  if (!s) return null;
  const dates: any[] = Array.isArray(s.date_index_list) ? s.date_index_list : [];
  const items: any[] = s.data_item_list;
  if (!dates.length || !items.length) return null;

  const colNames = items.map((it, i) => {
    const base = it.show_name || it.event_show_name || it.name || `series_${i + 1}`;
    const lbl = it.show_label && it.show_label !== base ? `(${it.show_label})` : "";
    return `${base}${lbl}`;
  });
  const columns = ["date", ...colNames];
  const rows = dates.map((d, i) => [d, ...items.map((it) => (Array.isArray(it.data) ? (it.data[i] ?? null) : null))]);
  return { kind: "table", columns, rows, row_count: rows.length };
}

function genericResult(data: unknown): Record<string, any> {
  if (Array.isArray(data)) return { kind: "records", records: data, row_count: data.length };
  if (data && typeof data === "object") return { kind: "records", records: [data], row_count: 1 };
  return { kind: data == null ? "empty" : "scalar", value: data ?? null };
}

function errorResult(compiled_id: string, code: string, message: string, warnings: string[] = []): Record<string, any> {
  return {
    status: "error",
    compiled_id,
    execution_kind: "openapi",
    error: { code, message, retryable: code === "openapi_http_error" },
    warnings,
  };
}

function mapErrorCode(code: string | null | undefined): string {
  switch (code) {
    case "auth_failed":
      return "openapi_auth_failed";
    case "http_error":
      return "openapi_http_error";
    case "endpoint_not_in_manifest":
    case "missing_required_params":
    case "business_error":
      return "openapi_business_error";
    default:
      return "unknown_error";
  }
}
