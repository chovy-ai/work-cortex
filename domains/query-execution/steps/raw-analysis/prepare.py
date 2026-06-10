"""4B-5B: apply semantics and select raw-analysis data path."""

from __future__ import annotations


def run(ctx):
    intent = ctx.get("query_intent", {})
    return StepOutcome.next({
        "raw_context": {
            "intent": intent,
            "data_model": "knowledge-store/data-model.json",
            "selected_source": intent.get("source", "datafinder.openapi.analysis_query"),
        }
    })
