import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const validation = ctx.validation ?? { status: "ok", checks: [] };
  if (validation.status === "fail") {
    return StepOutcome.revise("fail", { validation }, "validation requested revision");
  }
  return StepOutcome.next({ validation }, "ok");
}
