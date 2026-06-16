/**
 * 10B: 执行 —— 按 compiled_query.source 三路分派：
 *   analysis_query → DataFinderClient.call("analysis.query", {dsl})，结果抽成表格
 *   kafka         → sample_kafka_events(config)
 *   local         → query_local_csv / query_local_ndjson(file, sql)
 * 任一路失败都产出合 schema 的 error ExecutionResult。
 */
import { StepOutcome } from "../../scheduler/scheduler.js";
import { DataFinderClient, loadConfigFromEnv, type APIResult } from "../../../datafinder-interface/client.js";
import { sample_kafka_events, type KafkaConfig } from "../../executors/kafka_executor.js";
import { query_local_csv, query_local_ndjson } from "../../executors/local_executor.js";

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const compiled = ctx["compiled_query"];
  if (!compiled?.["source"]) return StepOutcome.fail("raw execute: compiled_query.source 缺失");
  const compiled_id = `${ctx["run_id"] ?? "adhoc"}:${compiled["source"]}`;

  if (compiled["source"] === "datafinder.openapi.analysis_query") {
    return execAnalysis(ctx, compiled, compiled_id);
  }
  if (compiled["source"] === "kafka") {
    return execKafka(compiled, compiled_id);
  }
  if (compiled["source"] === "local") {
    return execLocal(compiled, compiled_id);
  }
  return StepOutcome.fail(`raw execute: 未知 source: ${compiled["source"]}`);
}

async function execAnalysis(ctx: Record<string, any>, compiled: any, compiled_id: string): Promise<StepOutcome> {
  let client: DataFinderClient;
  try {
    client = new DataFinderClient(loadConfigFromEnv());
  } catch (err) {
    return done(errorResult(compiled_id, "openapi", "openapi_auth_failed", `配置加载失败：${String(err)}`));
  }
  const res = await client.call("analysis.query", compiled["params"] ?? {});
  if (res.status !== "success") {
    return done(errorResult(compiled_id, "openapi", mapErrorCode(res.error_code), res.error_message ?? "unknown", res.warnings));
  }
  const table = extractSeriesTable(res.data);
  const result = table ?? genericResult(res.data);
  return done({ status: "success", compiled_id, execution_kind: "openapi", result, warnings: res.warnings ?? [] });
}

async function execKafka(compiled: any, compiled_id: string): Promise<StepOutcome> {
  const k = compiled["kafka"] ?? {};
  let app_id = 0;
  try {
    app_id = loadConfigFromEnv().app_id;
  } catch {
    /* app_id 缺省 0，kafka 过滤会落空但不崩 */
  }
  const config: KafkaConfig = {
    broker: k["broker"],
    topic: k["topic"],
    consumer_group: k["consumer_group"],
    app_id,
    sample_limit: k["sample_limit"],
    offset_policy: k["offset_policy"],
  };
  const res = await sample_kafka_events(config, compiled["event_name"] ?? null);
  if (res.status !== "success") {
    return done(errorResult(compiled_id, "kafka", "kafka_consume_failed", res.error_message ?? "unknown", res.warnings));
  }
  return done({
    status: "success",
    compiled_id,
    execution_kind: "kafka",
    result: { kind: "raw_events", records: res.records, row_count: res.row_count },
    warnings: res.warnings ?? [],
  });
}

async function execLocal(compiled: any, compiled_id: string): Promise<StepOutcome> {
  const fn = compiled["format"] === "ndjson" ? query_local_ndjson : query_local_csv;
  const res = await fn(compiled["file_path"], compiled["sql"]);
  if (res.status !== "success") {
    return done(errorResult(compiled_id, "local_sql", "local_query_failed", res.error_message ?? "unknown", res.warnings));
  }
  return done({
    status: "success",
    compiled_id,
    execution_kind: "local_sql",
    result: { kind: "table", columns: res.columns, rows: res.rows, row_count: res.row_count },
    warnings: res.warnings ?? [],
  });
}

/** 在 analysis 结果里深找 date_index_list + data_item_list，抽成 date × 指标 表格。 */
function extractSeriesTable(data: any): Record<string, any> | null {
  let node: any = null;
  const seen = new Set<object>();
  const visit = (v: any): void => {
    if (node || !v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v["date_index_list"]) && Array.isArray(v["data_item_list"]) && v["data_item_list"].length) {
      node = v;
      return;
    }
    (Array.isArray(v) ? v : Object.values(v)).forEach(visit);
  };
  visit(data);
  if (!node) return null;
  const dates: any[] = node["date_index_list"];
  const items: any[] = node["data_item_list"];
  const colNames = items.map((it, i) => {
    const base = it["show_name"] || it["event_show_name"] || it["name"] || `series_${i + 1}`;
    const lbl = it["show_label"] && it["show_label"] !== base ? `(${it["show_label"]})` : "";
    return `${base}${lbl}`;
  });
  const columns = ["date", ...colNames];
  const rows = dates.map((d, i) => [d, ...items.map((it) => (Array.isArray(it["data"]) ? (it["data"][i] ?? null) : null))]);
  return { kind: "table", columns, rows, row_count: rows.length };
}

function genericResult(data: unknown): Record<string, any> {
  if (Array.isArray(data)) return { kind: "records", records: data, row_count: data.length };
  if (data && typeof data === "object") return { kind: "records", records: [data], row_count: 1 };
  return { kind: data == null ? "empty" : "scalar", value: data ?? null };
}

function done(execution_result: Record<string, any>): StepOutcome {
  return StepOutcome.next({ execution_result });
}

function errorResult(
  compiled_id: string,
  kind: string,
  code: string,
  message: string,
  warnings: string[] = [],
): Record<string, any> {
  return {
    status: "error",
    compiled_id,
    execution_kind: kind,
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
