import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const intent = ctx.query_intent ?? {};
  return StepOutcome.next({
    raw_context: {
      intent,
      data_model: "knowledge-store/data-model.json",
      selected_source: intent.source ?? "datafinder.openapi.analysis_query"
    }
  });
}
