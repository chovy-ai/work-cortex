/** 7B: human review gate. */

import { StepOutcome } from "../../scheduler/scheduler.js";

export function run(ctx: Record<string, any>): StepOutcome {
  const review = ctx["user_review"];
  if (review === undefined || review === null) {
    // 真实方案在 raw_context（prepare 产出）里，query_intent 顶层没有 metric/event_set。
    const rc = (ctx["raw_context"] ?? {}) as Record<string, any>;
    const slots = ((ctx["query_intent"] ?? {})["slots"] ?? {}) as Record<string, any>;
    const warnings = [
      ...((ctx["auto_review"] ?? {})["warnings"] ?? []),
      ...(rc["warnings"] ?? []),
    ].filter((w, i, a) => w && a.indexOf(w) === i);
    const card = {
      metric: rc["metric"] ?? slots["metric"] ?? null,
      aggregation: rc["aggregation"] ?? null,
      identity: rc["identity"] ?? slots["identity"] ?? null,
      data_source: rc["data_source"] ?? null,
      event_set: rc["event_set"] ?? [],
      time_range: rc["time_range"] ?? slots["time_range"] ?? null,
      granularity: slots["granularity"] ?? null,
      breakdowns: slots["breakdowns"] ?? [],
      notes: rc["notes"] ?? null,
      warnings,
    };
    return StepOutcome.await_input("raw.user_review", { review_card: card });
  }
  if (review["status"] === "changes") {
    return StepOutcome.revise("changes", { user_review: review }, "user requested changes");
  }
  return StepOutcome.next({ user_review: review }, "confirmed");
}
