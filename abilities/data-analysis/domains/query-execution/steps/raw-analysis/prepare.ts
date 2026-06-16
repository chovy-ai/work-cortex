/**
 * 4B–5B: 准备（LLM→schema）——读口径协议 + capabilities，按 QueryIntent 选定数据路径与口径，
 * 产出 raw_context 供后续 plan/compile 用。知识来源是手写协议（应用提取就绪后可换成 data-model.json）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStructured } from "atomic-abilities";
import { StepOutcome } from "../../scheduler/scheduler.js";

// build/domains/query-execution/steps/raw-analysis/prepare.js → 仓库根（上 5 层）
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const MODEL_PROTOCOL = join(REPO_ROOT, "domains", "metric-semantics", "data-model-protocol.md");
const CAPABILITIES = join(REPO_ROOT, "domains", "intent-routing", "capabilities.json");

const RAW_CONTEXT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["data_source"],
  properties: {
    data_source: { enum: ["analysis_query", "kafka", "local"] }, // 选定的数据路径
    metric: { type: "string" }, // 口径：指标
    identity: { type: "string" }, // 身份键
    aggregation: { type: "string" }, // 聚合口径说明
    time_range: { type: ["string", "object"] },
    event_set: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const intent = ctx["query_intent"];
  if (!intent || intent.status !== "matched") {
    return StepOutcome.fail("raw prepare: 缺少 matched 的 QueryIntent");
  }

  const protocol = readFileSync(MODEL_PROTOCOL, "utf8");
  const capabilities = readFileSync(CAPABILITIES, "utf8");
  const prompt = [
    "你是数据分析准备器。依据下面的口径协议与能力清单，为这条已匹配的 QueryIntent 选定数据路径与口径。",
    "[数据模型/口径协议]",
    protocol,
    "",
    "[capabilities.json]",
    capabilities,
    "",
    "[QueryIntent]",
    JSON.stringify(intent),
    "",
    "产出 raw_context：data_source 选 analysis_query/kafka/local；metric/identity/aggregation 按口径协议填；event_set 取需要的事件；不确定处写进 warnings。",
  ].join("\n");

  let raw_context: Record<string, any>;
  try {
    raw_context = await runStructured<Record<string, any>>({ prompt, outputSchema: RAW_CONTEXT_SCHEMA, agent: "claude" });
  } catch (err) {
    return StepOutcome.fail(`raw prepare: 口径准备失败：${String(err)}`);
  }
  return StepOutcome.next({ raw_context });
}
