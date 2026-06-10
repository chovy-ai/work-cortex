"""7B: human review gate."""

from __future__ import annotations


def run(ctx):
    review = ctx.get("user_review")
    if review is None:
        card = {
            "formula": ctx.get("query_intent", {}).get("metric", "pending"),
            "event_set": ctx.get("query_intent", {}).get("event_set", []),
            "warnings": ctx.get("auto_review", {}).get("warnings", []),
        }
        return StepOutcome.await_input("raw.user_review", {"review_card": card})
    if review.get("status") == "changes":
        return StepOutcome.revise("changes", {"user_review": review}, "user requested changes")
    return StepOutcome.next({"user_review": review}, branch="confirmed")
