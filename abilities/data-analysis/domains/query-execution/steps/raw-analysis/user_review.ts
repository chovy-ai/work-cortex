/** 7B: human review gate. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const review = ctx["user_review"];
  if (review === undefined || review === null) {
    const card = {
      formula: (ctx["query_intent"] ?? {})["metric"] ?? "pending",
      event_set: (ctx["query_intent"] ?? {})["event_set"] ?? [],
      warnings: (ctx["auto_review"] ?? {})["warnings"] ?? [],
    };
    return StepOutcome.await_input("raw.user_review", { review_card: card });
  }
  if (review["status"] === "changes") {
    return StepOutcome.revise("changes", { user_review: review }, "user requested changes");
  }
  return StepOutcome.next({ user_review: review }, "confirmed");
}
