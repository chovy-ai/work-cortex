"""5A: build dashboard QueryPlan."""

from __future__ import annotations


def run(ctx):
    intent = ctx.get("query_intent", {})
    slots = intent.get("slots", {})
    time_range = slots.get("time_range") or ctx.get("time_range")
    if not ctx.get("asset_id") or not time_range:
        return StepOutcome.await_input("dashboard.plan", {"missing": "asset_id or time_range"})
    return StepOutcome.next({
        "query_plan": {
            "query_path": "dashboard",
            "asset_id": ctx["asset_id"],
            "time_range": time_range,
        }
    })
