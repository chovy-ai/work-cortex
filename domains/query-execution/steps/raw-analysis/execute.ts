import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const compiled = ctx.compiled_query;
  if (!compiled) {
    return StepOutcome.fail("raw_analysis compiled_query missing");
  }
  return StepOutcome.next({
    execution_result: {
      status: "not_executed",
      source: compiled.source,
      reason: "Execution delegates to DataFinder, Kafka, or local executors per compiled source."
    }
  });
}
