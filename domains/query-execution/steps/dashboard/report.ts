import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  return StepOutcome.done({ report: ctx.execution_result ?? {} });
}
