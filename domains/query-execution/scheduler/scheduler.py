#!/usr/bin/env python3
"""Declarative query-execution scheduler."""

import importlib.util
import json
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional


ROOT = Path(__file__).resolve().parents[3]
WORKFLOW = Path(__file__).with_name("workflow.json")
OUTPUTS = ROOT / "outputs"


@dataclass
class StepOutcome:
    status: str
    branch: str = "next"
    context_patch: dict[str, Any] = field(default_factory=dict)
    await_step: Optional[str] = None
    payload: dict[str, Any] = field(default_factory=dict)
    message: str = ""

    @classmethod
    def next(cls, patch: Optional[dict[str, Any]] = None, branch: str = "next") -> "StepOutcome":
        return cls(status="next", branch=branch, context_patch=patch or {})

    @classmethod
    def revise(cls, branch: str, patch: Optional[dict[str, Any]] = None, message: str = "") -> "StepOutcome":
        return cls(status="revise", branch=branch, context_patch=patch or {}, message=message)

    @classmethod
    def await_input(cls, step_id: str, payload: Optional[dict[str, Any]] = None) -> "StepOutcome":
        return cls(status="await_input", await_step=step_id, payload=payload or {})

    @classmethod
    def done(cls, patch: Optional[dict[str, Any]] = None) -> "StepOutcome":
        return cls(status="done", context_patch=patch or {})

    @classmethod
    def fail(cls, message: str, patch: Optional[dict[str, Any]] = None) -> "StepOutcome":
        return cls(status="failed", context_patch=patch or {}, message=message)


@dataclass
class SchedulerState:
    run_id: str
    current_step: str
    context: dict[str, Any] = field(default_factory=dict)
    status: str = "running"
    revisions: dict[str, int] = field(default_factory=dict)
    awaiting_step: Optional[str] = None
    await_payload: dict[str, Any] = field(default_factory=dict)
    history: list[dict[str, Any]] = field(default_factory=list)

    def apply(self, outcome: StepOutcome) -> None:
        self.context.update(outcome.context_patch)
        self.history.append(asdict(outcome))
        if outcome.status == "await_input":
            self.status = "awaiting_input"
            self.awaiting_step = outcome.await_step
            self.await_payload = outcome.payload
        elif outcome.status == "failed":
            self.status = "failed"
        elif outcome.status == "done":
            self.status = "completed"


class StepScheduler:
    def __init__(self, workflow_path: Path = WORKFLOW, outputs_dir: Path = OUTPUTS) -> None:
        self.workflow_path = workflow_path
        self.outputs_dir = outputs_dir
        self.workflow = json.loads(workflow_path.read_text(encoding="utf-8"))
        self.steps = {step["id"]: step for step in self.workflow["steps"]}

    def new_state(self, context: Optional[dict[str, Any]] = None, run_id: Optional[str] = None) -> SchedulerState:
        return SchedulerState(
            run_id=run_id or uuid.uuid4().hex,
            current_step=self.workflow["start"],
            context=context or {},
        )

    def persist(self, state: SchedulerState) -> Path:
        run_dir = self.outputs_dir / state.run_id
        run_dir.mkdir(parents=True, exist_ok=True)
        path = run_dir / "state.json"
        path.write_text(json.dumps(asdict(state), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        return path

    def resume(self, run_id: str) -> SchedulerState:
        path = self.outputs_dir / run_id / "state.json"
        payload = json.loads(path.read_text(encoding="utf-8"))
        return SchedulerState(**payload)

    def run(self, state: SchedulerState) -> SchedulerState:
        while state.status == "running":
            outcome = self._run_step(state.current_step, state.context)
            state.apply(outcome)
            if state.status != "running":
                self.persist(state)
                return state
            state.current_step = self._next_step(state.current_step, outcome, state)
            self.persist(state)
        return state

    def provide_input(self, state: SchedulerState, payload: dict[str, Any]) -> SchedulerState:
        if state.status != "awaiting_input":
            raise ValueError("state is not awaiting input")
        state.context["user_review"] = payload
        state.status = "running"
        state.awaiting_step = None
        state.await_payload = {}
        return state

    def _run_step(self, step_id: str, context: dict[str, Any]) -> StepOutcome:
        runner = self._load_runner(step_id)
        outcome = runner(context)
        if not isinstance(outcome, StepOutcome):
            raise TypeError(f"{step_id}.run(ctx) must return StepOutcome")
        return outcome

    def _load_runner(self, step_id: str) -> Callable[[dict[str, Any]], StepOutcome]:
        step = self.steps[step_id]
        path = ROOT / step["run"]
        spec = importlib.util.spec_from_file_location(step_id.replace(".", "_"), path)
        if spec is None or spec.loader is None:
            raise ImportError(f"cannot load step {step_id} from {path}")
        module = importlib.util.module_from_spec(spec)
        module.StepOutcome = StepOutcome
        spec.loader.exec_module(module)
        return module.run

    def _next_step(self, step_id: str, outcome: StepOutcome, state: SchedulerState) -> str:
        if self.steps[step_id].get("kind") == "terminal":
            state.status = "completed"
            return step_id

        if outcome.status == "revise":
            back = self.workflow.get("backEdges", {}).get(step_id, {})
            target = back.get(outcome.branch)
            if target is None:
                raise ValueError(f"step {step_id} cannot revise via branch {outcome.branch}")
            count = state.revisions.get(step_id, 0) + 1
            state.revisions[step_id] = count
            if count > int(back.get("maxRevisions", 0)):
                state.status = "failed"
                return step_id
            return target

        branch = outcome.branch
        if step_id == "route":
            branch = state.context.get("query_path", branch)
        target = self.workflow.get("edges", {}).get(step_id, {}).get(branch)
        if target is None:
            raise ValueError(f"step {step_id} has no edge for branch {branch}")
        return target


def main() -> int:
    scheduler = StepScheduler()
    state = scheduler.new_state()
    scheduler.persist(state)
    print(f"created scheduler state: {state.run_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
