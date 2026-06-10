import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const compiled = ctx.compiled_query;
  if (!compiled) {
    return StepOutcome.fail("dashboard compiled_query missing");
  }
  return StepOutcome.next({
    execution_result: {
      status: "not_executed",
      source: compiled.source,
      reason: "DataFinder credentials/live call are handled by domains/datafinder-interface/client.ts."
    }
  });
}
