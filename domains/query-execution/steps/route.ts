/** S2: route by QueryIntent.query_path. */

import { StepOutcome } from "../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const query_path = ctx["query_path"] || (ctx["query_intent"] ?? {})["query_path"];
  if (query_path !== "dashboard" && query_path !== "raw_analysis") {
    return StepOutcome.fail(`unsupported query_path: ${query_path}`);
  }
  return StepOutcome.next({ query_path }, query_path);
}
