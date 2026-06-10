"""10B: execute raw-analysis compiled query placeholder."""

from __future__ import annotations


def run(ctx):
    compiled = ctx.get("compiled_query")
    if not compiled:
        return StepOutcome.fail("raw_analysis compiled_query missing")
    return StepOutcome.next({
        "execution_result": {
            "status": "not_executed",
            "source": compiled["source"],
            "reason": "Execution delegates to DataFinder, Kafka, or local executors per compiled source.",
        }
    })
