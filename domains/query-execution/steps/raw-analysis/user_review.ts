import { StepOutcome, type Context } from "../../scheduler/scheduler.ts";

export function run(ctx: Context): StepOutcome {
  const review = ctx.user_review;
  if (review === undefined) {
    return StepOutcome.awaitInput("raw.user_review", {
      review_card: {
        formula: ctx.query_intent?.metric ?? "pending",
        event_set: ctx.query_intent?.event_set ?? [],
        warnings: ctx.auto_review?.warnings ?? []
      }
    });
  }
  if (review.status === "changes") {
    return StepOutcome.revise("changes", { user_review: review }, "user requested changes");
  }
  return StepOutcome.next({ user_review: review }, "confirmed");
}
