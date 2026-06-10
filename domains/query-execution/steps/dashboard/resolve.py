"""4A: resolve dashboard/report asset ids."""

from __future__ import annotations


def run(ctx):
    intent = ctx.get("query_intent", {})
    slots = intent.get("slots", {})
    asset_id = slots.get("report_id") or slots.get("dashboard_id") or ctx.get("asset_id")
    if not asset_id:
        return StepOutcome.await_input("dashboard.resolve", {"missing": "report_id or dashboard_id"})
    return StepOutcome.next({"asset_id": asset_id})
