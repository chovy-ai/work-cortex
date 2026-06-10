"""8A: produce dashboard result."""

from __future__ import annotations


def run(ctx):
    return StepOutcome.done({"report": ctx.get("execution_result", {})})
