/**
 * S1: 自然语言 → QueryIntent（唯一必经 LLM 入口）。
 * 用 atomic-abilities 的 runStructured，把 intent-routing 的协议 + capabilities + 用户问题
 * 拼成提示词，强制产出合 query-intent.schema.json 的 QueryIntent。query_path 由 category 派生
 * （schema 本身不含该字段）。
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runStructured } from "atomic-abilities";
import { StepOutcome } from "../scheduler/scheduler.js";

// build/domains/query-execution/steps/understand.js → 仓库根（上 4 层）
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IR_DIR = join(REPO_ROOT, "domains", "intent-routing");

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  let intent: Record<string, any> | undefined = ctx["query_intent"];

  // 已注入 query_intent（测试/打回重试）则复用，否则跑 S1
  if (!intent || Object.keys(intent).length === 0) {
    const text: string = ctx["text"] ?? ctx["input_text"] ?? "";
    if (!text.trim()) return StepOutcome.fail("understand: 缺少用户问题文本（ctx.text）");

    const protocol = readFileSync(join(IR_DIR, "query-intent-protocol.md"), "utf8");
    const capabilities = readFileSync(join(IR_DIR, "capabilities.json"), "utf8");
    const schema = JSON.parse(readFileSync(join(IR_DIR, "query-intent.schema.json"), "utf8"));

    const prompt = [
      protocol,
      "",
      "[capabilities.json]",
      capabilities,
      "",
      "请把下面这条用户请求解析成一个 QueryIntent（original_text 用用户原文）：",
      text,
    ].join("\n");

    try {
      intent = await runStructured<Record<string, any>>({ prompt, outputSchema: schema, agent: "claude" });
    } catch (err) {
      return StepOutcome.fail(`understand: 意图解析失败：${String(err)}`);
    }
  }

  if (intent["status"] === "unsupported") {
    return StepOutcome.fail(`understand: 不支持的请求：${intent["reason"] ?? ""}`);
  }
  if (intent["status"] === "needs_clarification") {
    return StepOutcome.await_input("understand", {
      clarification_question: intent["clarification_question"] ?? "需要更多信息才能继续",
    });
  }

  return StepOutcome.next({ query_intent: intent, query_path: deriveQueryPath(intent) });
}

/** dashboard = 复用已有报表/看板资产；其余走 raw_analysis。 */
function deriveQueryPath(intent: Record<string, any>): string {
  return intent["category"] === "asset_reuse" ? "dashboard" : "raw_analysis";
}
