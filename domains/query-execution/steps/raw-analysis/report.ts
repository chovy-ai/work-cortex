/** Raw-analysis final report step. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  return StepOutcome.done({ report: ctx["execution_result"] ?? {} });
}
