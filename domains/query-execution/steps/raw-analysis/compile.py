"""9B: compile raw-analysis QueryPlan."""

from __future__ import annotations


def run(ctx):
    plan = ctx.get("query_plan")
    if not plan:
        return StepOutcome.fail("raw_analysis query_plan missing")
    source = plan.get("raw_context", {}).get("selected_source", "datafinder.openapi.analysis_query")
    return StepOutcome.next({"compiled_query": {"source": source, "plan": plan}})
