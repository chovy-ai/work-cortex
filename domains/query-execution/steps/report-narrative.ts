/**
 * 报告环节的叙述渲染（LLM，对齐 ARCHITECTURE「报告 = LLM 叙述 + workflow 图表」）。
 * 用 runStructured 把「用户问题 + 查询结果」转成结论先行的中文叙述（结构化、合 schema）。
 * 叙述是增强项——非成功结果 / 失败时返回 null，绝不阻断报告主体。
 */
import { runStructured } from "atomic-abilities";
import { describeResult } from "./report-charts.js";

const SUMMARY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary"],
  properties: {
    summary: { type: "string", minLength: 1 }, // 结论先行，一句话含关键数字
    highlights: { type: "array", items: { type: "string" } }, // 2–4 个关键数字点
    caveats: { type: "string" }, // 口径说明（可选）
  },
} as const;

export interface ReportNarrative {
  summary: string;
  highlights?: string[];
  caveats?: string;
}

export async function renderNarrative(ctx: Record<string, any>): Promise<ReportNarrative | null> {
  const er = ctx["execution_result"];
  if (!er || er.status !== "success" || !er.result) return null;

  const question: string = ctx["text"] ?? ctx["input_text"] ?? "(未知问题)";
  const data = describeResult(er.result);

  const prompt = [
    "你是数据分析师，面向业务同学（不是工程师）。根据下面的查询结果回答用户问题。",
    `[用户问题]\n${question}`,
    `[查询结果 CSV]\n${data}`,
    "",
    "要求：summary 一句话结论先行（含关键数字）；highlights 列 2–4 个关键数字点；caveats 简短口径说明（没有可省略）。全部用中文，不要写分析过程。",
  ].join("\n");

  try {
    return await runStructured<ReportNarrative>({ prompt, outputSchema: SUMMARY_SCHEMA, agent: "claude" });
  } catch {
    return null; // 叙述失败不挡报告主体
  }
}
