/**
 * 11B: 结果质量校验 gate（确定性检查先行）。
 * 执行失败 / 空结果 → revise 打回 plan（compile 的 DSL 由 LLM 构造，重跑可能产出不同 DSL；上限 2 由调度器管）。
 * 全零 / 负值等可疑但非致命 → 通过并附 warning，交报告环节说明。
 * 说明：LLM 合理性判断（架构里的「后置」部分）暂不做，保持纯 workflow、可无 agent 验证。
 */
import { StepOutcome } from "../../scheduler/scheduler.js";

interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export function run(ctx: Record<string, any>): StepOutcome {
  const er = ctx["execution_result"];
  if (!er) return StepOutcome.fail("raw validate: execution_result 缺失");

  // 1. 执行失败 → 打回
  if (er["status"] === "error") {
    const msg = er["error"]?.["message"] ?? er["error"]?.["code"] ?? "执行失败";
    return StepOutcome.revise(
      "fail",
      { validation: { status: "fail", reason: "execution_error", detail: msg, checks: [{ name: "execution_success", ok: false }] } },
      `执行失败：${msg}`,
    );
  }

  const r = er["result"] ?? {};
  const rowCount: number = r["row_count"] ?? r["rows"]?.length ?? r["records"]?.length ?? 0;
  const checks: Check[] = [];

  // 2. 空结果 → 打回（常因口径/时间范围错）
  const empty = r["kind"] === "empty" || rowCount === 0;
  checks.push({ name: "non_empty", ok: !empty, detail: `row_count=${rowCount}` });
  if (empty) {
    return StepOutcome.revise("fail", { validation: { status: "fail", reason: "empty_result", checks } }, "结果为空，可能口径或时间范围有误");
  }

  // 3. 可疑但非致命 → warning（通过）
  const warnings: string[] = [];
  if (r["kind"] === "table" && Array.isArray(r["rows"]) && r["rows"].length) {
    const dataCells = (row: any[]): any[] => row.slice(1); // 跳过首列（通常是 date/维度）
    const allZero = r["rows"].every((row: any[]) => dataCells(row).every((v) => v === 0 || v == null));
    checks.push({ name: "not_all_zero", ok: !allZero });
    if (allZero) warnings.push("数据除首列外全为 0/空，请确认口径或时间范围");

    const hasNegative = r["rows"].some((row: any[]) => dataCells(row).some((v) => typeof v === "number" && v < 0));
    checks.push({ name: "no_negative", ok: !hasNegative });
    if (hasNegative) warnings.push("存在负值，计数类指标异常");
  }

  return StepOutcome.next({ validation: { status: "ok", checks, warnings } }, "ok");
}
