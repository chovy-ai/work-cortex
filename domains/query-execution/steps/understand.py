"""S1: natural language to QueryIntent placeholder step."""

from __future__ import annotations


def run(ctx):
    intent = dict(ctx.get("query_intent") or {})
    if not intent:
        intent = {
            "query_path": ctx.get("query_path", "raw_analysis"),
            "warnings": ["QueryIntent must be produced from domains/intent-routing protocols before execution."],
        }
    query_path = intent.get("query_path", "raw_analysis")
    return StepOutcome.next({"query_intent": intent, "query_path": query_path})
