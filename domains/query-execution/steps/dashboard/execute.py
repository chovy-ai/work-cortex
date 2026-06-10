"""7A: execute dashboard query placeholder."""

from __future__ import annotations


def run(ctx):
    compiled = ctx.get("compiled_query")
    if not compiled:
        return StepOutcome.fail("dashboard compiled_query missing")
    return StepOutcome.next({
        "execution_result": {
            "status": "not_executed",
            "source": compiled["source"],
            "reason": "DataFinder credentials/live call are handled by domains/datafinder-interface/client.py.",
        }
    })
