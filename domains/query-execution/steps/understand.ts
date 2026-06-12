/** S1: natural language to QueryIntent placeholder step. */

import { StepOutcome } from "../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  let intent: Record<string, any> = { ...(ctx["query_intent"] || {}) };
  if (Object.keys(intent).length === 0) {
    intent = {
      query_path: ctx["query_path"] ?? "raw_analysis",
      warnings: ["QueryIntent must be produced from domains/intent-routing protocols before execution."],
    };
  }
  const query_path = intent["query_path"] ?? "raw_analysis";
  return StepOutcome.next({ query_intent: intent, query_path });
}
