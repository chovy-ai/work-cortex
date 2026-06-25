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
import { fillAppPlaceholders } from "../../app-config/config.js";

// build/domains/query-execution/steps/understand.js → 仓库根（上 4 层）
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const IR_DIR = join(REPO_ROOT, "domains", "intent-routing");

export async function run(ctx: Record<string, any>): Promise<StepOutcome> {
  let intent: Record<string, any> | undefined = ctx["query_intent"];
  const text: string = ctx["text"] ?? ctx["input_text"] ?? "";

  // 已注入 query_intent（测试/打回重试）则复用，否则跑 S1
  if (!intent || Object.keys(intent).length === 0) {
    if (!text.trim()) return StepOutcome.fail("understand: 缺少用户问题文本（ctx.text）");

    const protocol = fillAppPlaceholders(readFileSync(join(IR_DIR, "query-intent-protocol.md"), "utf8"), REPO_ROOT);
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
    // 没命中任何注册能力不是"失败"，而是"没听懂"——先针对这次输入说清哪里意图不明，
    // 再附一小段能力引导。以 done 终态走正常 result 渲染（不带「分析失败」前缀）；
    // 原始英文 reason 留进 state 供排查。说明文案另起一个聚焦小调用生成——把"产中文
    // 说明"塞进上面的大 prompt 会让模型偶尔输出散文、破坏 JSON-only。
    const why = await explainUnsupported(text, String(intent["reason"] ?? ""));
    return StepOutcome.done({
      report: { summary: unsupportedReply(why) },
      unsupported_reason: intent["reason"] ?? "",
    });
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

/**
 * 针对这次输入生成一句面向用户的中文说明（哪里缺少可分析的意图）。独立小调用：schema
 * 只有 message 一个字段、无 $id，比塞进 understand 大 prompt 稳得多。失败/空则回显输入兜底。
 */
async function explainUnsupported(text: string, reason: string): Promise<string> {
  const prompt = [
    `用户向数据分析助手提了：「${text}」。`,
    `但它不对应任何数据分析能力。内部判定原因（英文，仅供参考）：${reason}`,
    "请用一句面向普通用户的中文，具体说明这次输入哪里缺少可分析的意图、为什么无法分析。"
      + "不要英文、不要技术术语、不要罗列能力清单。",
  ].join("\n");
  try {
    const out = await runStructured<{ message?: string }>({
      prompt,
      outputSchema: {
        type: "object",
        required: ["message"],
        additionalProperties: false,
        properties: { message: { type: "string" } },
      },
      agent: "claude",
      timeoutMs: 60_000,
    });
    return String(out?.message ?? "").trim() || fallbackWhy(text);
  } catch {
    return fallbackWhy(text);
  }
}

/** 说明调用失败时的兜底：回显（截断）用户输入，仍比通用话术具体。 */
function fallbackWhy(text: string): string {
  const t = text.trim();
  const shown = t.length > 30 ? `${t.slice(0, 30)}…` : t;
  return shown ? `没太理解「${shown}」想分析什么。` : "没太理解这个问题想分析什么。";
}

/**
 * 请求没命中任何注册能力时的回复：先针对这次输入说清「哪里意图不明」（explainUnsupported
 * 生成），再附一小段能力引导帮用户改问法。
 * 引导例子贴合 capabilities.json 的四类能力，措辞保持应用无关（不写死具体事件名）。
 */
function unsupportedReply(why: string): string {
  const head = why || "没太理解这个问题想分析什么。";
  return [
    head,
    "",
    "我能做这几类分析，换个说法我就能帮上忙：",
    "· 指标趋势：如「昨天的 DAU」「某事件最近 7 天的每日趋势」",
    "· 维度拆分：如「某指标按渠道 / 版本 / provider 拆分」",
    "· 用户与分群：查某个用户或设备的行为、某个分群的规模",
    "· 看板复用：直接读已有的看板或报表",
  ].join("\n");
}
