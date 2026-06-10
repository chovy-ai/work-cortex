"""8B: build raw-analysis QueryPlan."""

from __future__ import annotations


def run(ctx):
    return StepOutcome.next({
        "query_plan": {
            "query_path": "raw_analysis",
            "intent": ctx.get("query_intent", {}),
            "raw_context": ctx.get("raw_context", {}),
        }
    })
