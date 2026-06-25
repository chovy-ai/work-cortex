/**
 * 10B: 执行 —— 按 compiled_query.source 三路分派：
 *   analysis_query → datafinder-access.runAnalysisQuery（门面统一调用/归一/抽表）
 *   kafka         → sample_kafka_events(config)
 *   local         → query_local_csv / query_local_ndjson(file, sql)
 * 任一路失败都产出合 schema 的 error ExecutionResult。
 */
import { StepOutcome } from "../../scheduler/scheduler.js";
import { dataFinder, dataFinderConfig } from "../../../datafinder-interface/index.js";
import { sample_kafka_events, type KafkaConfig } from "../../executors/kafka_executor.js";
import { query_local_csv, query_local_ndjson } from "../../executors/local_executor.js";

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const compiled = ctx["compiled_query"];
  if (!compiled?.["source"]) return StepOutcome.fail("raw execute: compiled_query.source 缺失");
  const compiled_id = `${ctx["run_id"] ?? "adhoc"}:${compiled["source"]}`;

  if (compiled["source"] === "datafinder.openapi.analysis_query") {
    return execAnalysis(compiled, compiled_id);
  }
  if (compiled["source"] === "kafka") {
    return execKafka(compiled, compiled_id);
  }
  if (compiled["source"] === "local") {
    return execLocal(compiled, compiled_id);
  }
  return StepOutcome.fail(`raw execute: 未知 source: ${compiled["source"]}`);
}

async function execAnalysis(compiled: any, compiled_id: string): Promise<StepOutcome> {
  const r = await dataFinder().call("analysis.query", (compiled["params"] ?? {}) as Record<string, unknown>);
  if (!r.ok) return done(errorResult(compiled_id, "openapi", r.code, r.message, r.warnings));
  return done({ status: "success", compiled_id, execution_kind: "openapi", result: r.result, warnings: r.warnings });
}

async function execKafka(compiled: any, compiled_id: string): Promise<StepOutcome> {
  const k = compiled["kafka"] ?? {};
  let app_id = 0;
  try {
    app_id = dataFinderConfig().app_id;
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
