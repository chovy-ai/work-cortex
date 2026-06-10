import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const review = ctx.auto_review ?? { status: "approved", warnings: [] };
  if (review.status === "requires_revision") {
    return StepOutcome.revise("requires_revision", { auto_review: review }, "auto review requested revision");
  }
  return StepOutcome.next({ auto_review: review }, "approved");
}
