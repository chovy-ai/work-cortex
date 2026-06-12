/** 4B-5B: apply semantics and select raw-analysis data path. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const intent = ctx["query_intent"] ?? {};
  return StepOutcome.next({
    raw_context: {
      intent,
      data_model: "knowledge-store/data-model.json",
      selected_source: intent["source"] ?? "datafinder.openapi.analysis_query",
    },
  });
}
