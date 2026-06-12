/** 6B: automated semantic review gate. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const review = ctx["auto_review"] ?? { status: "approved", warnings: [] };
  if (review["status"] === "requires_revision") {
    return StepOutcome.revise("requires_revision", { auto_review: review }, "auto review requested revision");
  }
  return StepOutcome.next({ auto_review: review }, "approved");
}
