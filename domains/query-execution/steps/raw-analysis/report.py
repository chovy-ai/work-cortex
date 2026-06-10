"""Raw-analysis final report step."""

from __future__ import annotations


def run(ctx):
    return StepOutcome.done({"report": ctx.get("execution_result", {})})
