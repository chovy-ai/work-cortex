"""6B: automated semantic review gate."""

from __future__ import annotations


def run(ctx):
    review = ctx.get("auto_review", {"status": "approved", "warnings": []})
    if review.get("status") == "requires_revision":
        return StepOutcome.revise("requires_revision", {"auto_review": review}, "auto review requested revision")
    return StepOutcome.next({"auto_review": review}, branch="approved")
