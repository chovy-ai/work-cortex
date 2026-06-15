/**
 * 6B: 自动评审 gate（LLM）——独立评审 agent 按 review-protocol Stage 1，仅凭 QueryIntent +
 * raw_context + 口径协议判断计划是否可靠。requires_revision 打回 prepare（上限 2，调度器管）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStructured } from "atomic-abilities";
import { StepOutcome } from "../../scheduler/scheduler.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const REVIEW_PROTOCOL = join(REPO_ROOT, "domains", "query-execution", "protocols", "raw-analysis", "review-protocol.md");
const MODEL_PROTOCOL = join(REPO_ROOT, "domains", "metric-semantics", "data-model-protocol.md");

const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision"],
  properties: {
    decision: { enum: ["approved", "requires_revision"] },
    issues: { type: "array", items: { type: "string" } }, // requires_revision 时的具体问题
    warnings: { type: "array", items: { type: "string" } },
  },
} as const;

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  const intent = ctx["query_intent"];
  const raw_context = ctx["raw_context"];
  if (!intent || !raw_context) {
    return StepOutcome.fail("raw auto_review: 缺少 query_intent 或 raw_context");
  }

  const reviewProtocol = readFileSync(REVIEW_PROTOCOL, "utf8");
  const modelProtocol = readFileSync(MODEL_PROTOCOL, "utf8");
  const prompt = [
    "你是独立评审 agent，按下面的 Review Protocol（Stage 1）评审本次分析准备是否可靠。",
    "只依据 QueryIntent、raw_context 和口径协议判断，不臆测对话历史。",
    "[Review Protocol]",
    reviewProtocol,
    "",
    "[数据模型/口径协议]",
    modelProtocol,
    "",
    "[QueryIntent]",
    JSON.stringify(intent),
    "[raw_context]",
    JSON.stringify(raw_context),
    "",
    "事件选择 / 口径定义 / 计算逻辑有错或可疑 → decision=requires_revision 并在 issues 列出；否则 approved。",
  ].join("\n");

  let review: Record<string, any>;
  try {
    review = await runStructured<Record<string, any>>({ prompt, outputSchema: REVIEW_SCHEMA, agent: "claude" });
  } catch (err) {
    return StepOutcome.fail(`raw auto_review: 评审失败：${String(err)}`);
  }

  if (review["decision"] === "requires_revision") {
    return StepOutcome.revise("requires_revision", { auto_review: review }, (review["issues"] ?? []).join("; "));
  }
  return StepOutcome.next({ auto_review: review }, "approved");
}
