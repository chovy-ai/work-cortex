/** 11B: result quality validation gate. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const validation = ctx["validation"] ?? { status: "ok", checks: [] };
  if (validation["status"] === "fail") {
    return StepOutcome.revise("fail", { validation }, "validation requested revision");
  }
  return StepOutcome.next({ validation }, "ok");
}
