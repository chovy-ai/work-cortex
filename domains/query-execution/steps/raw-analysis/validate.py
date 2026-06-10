"""11B: result quality validation gate."""

from __future__ import annotations


def run(ctx):
    validation = ctx.get("validation", {"status": "ok", "checks": []})
    if validation.get("status") == "fail":
        return StepOutcome.revise("fail", {"validation": validation}, "validation requested revision")
    return StepOutcome.next({"validation": validation}, branch="ok")
