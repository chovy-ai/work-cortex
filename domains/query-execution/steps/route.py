"""S2: route by QueryIntent.query_path."""

from __future__ import annotations


def run(ctx):
    query_path = ctx.get("query_path") or ctx.get("query_intent", {}).get("query_path")
    if query_path not in {"dashboard", "raw_analysis"}:
        return StepOutcome.fail(f"unsupported query_path: {query_path}")
    return StepOutcome.next({"query_path": query_path}, branch=query_path)
