/**
 * 9B: 编译 —— 三路分派的「造活儿」。
 * analysis_query：runStructured 拿真实 DSL 范例去改造（intent→DSL），环境关键字段用范例真值强制兜底；
 * kafka / local：从 slots 拼执行参数。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStructured } from "atomic-abilities";
import { StepOutcome } from "../../scheduler/scheduler.js";
import { dataFinderConfig } from "../../../datafinder-interface/index.js";
import { fillAppPlaceholders } from "../../../app-config/config.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const RA_DIR = join(REPO_ROOT, "domains", "query-execution", "protocols", "raw-analysis");
const MODEL_PROTOCOL = join(REPO_ROOT, "domains", "metric-semantics", "data-model-protocol.md");

// 宽松 schema —— DSL 的真正合法性由 DataFinder 裁定，这里只要求基本骨架
const DSL_SCHEMA = {
  type: "object",
  additionalProperties: true,
  required: ["content"],
  properties: {
    periods: { type: "array" },
    content: { type: "object" },
    resources: { type: "array" },
    version: {},
  },
} as const;

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const plan = ctx["query_plan"];
  if (!plan) return StepOutcome.fail("raw compile: query_plan 缺失");
  const source = plan["data_source"] ?? ctx["raw_context"]?.["data_source"];

  if (source === "analysis_query") return compileAnalysis(ctx);
  if (source === "kafka") return compileKafka(ctx);
  if (source === "local") return compileLocal(ctx);
  return StepOutcome.fail(`raw compile: 未知 data_source: ${source}`);
}

async function compileAnalysis(ctx: Record<string, any>): Promise<StepOutcome> {
  const exampleStr = readFileSync(join(RA_DIR, "analysis-dsl-example.json"), "utf8");
  const example = JSON.parse(exampleStr) as Record<string, any>;
  const protocol = fillAppPlaceholders(readFileSync(MODEL_PROTOCOL, "utf8"), REPO_ROOT);

  const prompt = [
    "你要为一次事件分析构造 DataFinder analysis DSL。下面给你一个【真实可用的 DSL 范例】，在它结构基础上改造：",
    "- 只改 periods（按需要的时间范围与粒度）与 content.queries（按需要的事件+指标：event_indicator=events 是次数 / event_users 是人数；event_name 用事件英文名如 predefine_pageview）；",
    "- content.profile_filters / content.option / option / version / show_option / resources / app_ids 等保持范例结构，不要乱改；",
    "- 需要拆维度时用 content.queries[].groups_v2，需要过滤用 filters。",
    "[DSL 范例]",
    exampleStr,
    "",
    "[口径协议]",
    protocol,
    "",
    "[QueryIntent]",
    JSON.stringify(ctx["query_intent"]),
    "[raw_context]",
    JSON.stringify(ctx["raw_context"]),
    "",
    "输出改造后的完整 DSL JSON。",
  ].join("\n");

  let dsl: Record<string, any>;
  try {
    dsl = await runStructured<Record<string, any>>({ prompt, outputSchema: DSL_SCHEMA, agent: "claude", timeoutMs: 180_000 });
  } catch (err) {
    return StepOutcome.fail(`raw compile: DSL 构造失败：${String(err)}`);
  }

  // 安全网：作用域字段不信任 LLM，强制用真实配置。app_id / project_id 来自 .env.local
  // （覆盖范例里的空 app_ids 与历史写死的 project_id），让查询真正打到本应用的数据；
  // subject_ids 等结构沿用范例（无独立配置来源）。
  const cfg = dataFinderConfig();
  const resources = (JSON.parse(JSON.stringify(example["resources"] ?? [])) as Record<string, any>[]);
  for (const r of resources) {
    r["app_ids"] = [cfg.app_id];
    if (cfg.project_id != null) r["project_ids"] = [cfg.project_id];
  }
  dsl["resources"] = resources;
  dsl["app_ids"] = [cfg.app_id];
  if (dsl["version"] == null) dsl["version"] = example["version"];

  return StepOutcome.next({
    compiled_query: {
      source: "datafinder.openapi.analysis_query",
      endpoint_id: "analysis.query",
      params: { dsl, timezone: "Asia/Shanghai" },
    },
  });
}

function compileKafka(ctx: Record<string, any>): StepOutcome {
  const slots = (ctx["query_intent"] ?? {})["slots"] ?? {};
  if (!slots["broker_or_zk"] || !slots["topic"]) {
    return StepOutcome.fail("raw compile(kafka): 缺 broker_or_zk / topic");
  }
  return StepOutcome.next({
    compiled_query: {
      source: "kafka",
      kafka: {
        broker: slots["broker_or_zk"],
        topic: slots["topic"],
        consumer_group: slots["consumer_group"] ?? "data-analysis-sampler",
        sample_limit: slots["sample_limit"],
        offset_policy: slots["offset_policy"],
      },
      event_name: slots["event_name"] ?? null,
    },
  });
}

function compileLocal(ctx: Record<string, any>): StepOutcome {
  const slots = (ctx["query_intent"] ?? {})["slots"] ?? {};
  const file_path = slots["file_path"];
  const sql = slots["sql"] ?? ctx["raw_context"]?.["sql"];
  if (!file_path || !sql) {
    return StepOutcome.fail("raw compile(local): 缺 file_path 或 sql");
  }
  return StepOutcome.next({
    compiled_query: { source: "local", file_path, format: slots["file_format"] ?? "csv", sql },
  });
}
