"""6A: compile dashboard QueryPlan."""

from __future__ import annotations


def run(ctx):
    plan = ctx.get("query_plan")
    if not plan:
        return StepOutcome.fail("dashboard query_plan missing")
    return StepOutcome.next({
        "compiled_query": {
            "source": "datafinder.openapi.report_query",
            "request": {
                "asset_id": plan["asset_id"],
                "time_range": plan["time_range"],
            },
        }
    })
