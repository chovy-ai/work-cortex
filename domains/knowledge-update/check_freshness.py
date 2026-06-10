#!/usr/bin/env python3
"""Freshness checks for data-analysis knowledge domains."""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
NEXTOP = ROOT.parent / "nextop"
MAX_DOC_AGE_DAYS = 30


def _load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def _git(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        timeout=15,
    )
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _origin_head(repo: Path) -> str:
    if not repo.exists():
        return ""
    remote = _git(repo, "remote", "get-url", "origin") or "origin"
    refs = _git(repo, "ls-remote", remote, "HEAD")
    return refs.split()[0][:7] if refs else ""


def _age_days(value: str | None) -> int | None:
    if not value:
        return None
    try:
        checked = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            checked = datetime.fromisoformat(f"{value}T00:00:00+00:00")
        except ValueError:
            return None
    if checked.tzinfo is None:
        checked = checked.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - checked).days


def check_event_knowledge() -> tuple[str, list[str]]:
    catalog = _load_json(ROOT / "knowledge-store" / "event-catalog.json")
    stored = str(catalog.get("nextop_commit", ""))
    remote = _origin_head(NEXTOP)
    if not catalog:
        return "stale", ["knowledge-store/event-catalog.json is missing"]
    if remote and stored and not remote.startswith(stored):
        return "stale", [f"nextop_commit {stored} != origin HEAD {remote}"]
    if not remote:
        return "unknown", ["could not read nextop origin HEAD"]
    return "fresh", [f"nextop_commit {stored} matches origin HEAD {remote}"]


def check_datafinder_interface() -> tuple[str, list[str]]:
    manifest = _load_json(ROOT / "domains" / "datafinder-interface" / "manifest.json")
    if not manifest:
        return "stale", ["manifest.json is missing"]
    unverified = [ep["id"] for ep in manifest.get("endpoints", []) if not ep.get("path_verified")]
    age = _age_days(manifest.get("last_verified_against_docs_at"))
    messages: list[str] = []
    if unverified:
        messages.append(f"{len(unverified)} endpoints path_verified=false: {', '.join(unverified)}")
    if age is None:
        messages.append("last_verified_against_docs_at is missing or invalid")
    elif age > MAX_DOC_AGE_DAYS:
        messages.append(f"last_verified_against_docs_at is {age} days old")
    if messages:
        return "stale", messages
    return "fresh", [f"{len(manifest.get('endpoints', []))} endpoints verified"]


def check_metric_semantics() -> tuple[str, list[str]]:
    model = _load_json(ROOT / "knowledge-store" / "data-model.json")
    stored = str(model.get("nextop_commit", ""))
    remote = _origin_head(NEXTOP)
    if not model:
        return "stale", ["knowledge-store/data-model.json is missing"]
    if stored == "unknown":
        return "unknown", ["data-model.json is still a placeholder"]
    if remote and stored and not remote.startswith(stored):
        return "stale", [f"nextop_commit {stored} != origin HEAD {remote}"]
    if not remote:
        return "unknown", ["could not read nextop origin HEAD"]
    return "fresh", [f"nextop_commit {stored} matches origin HEAD {remote}"]


CHECKS = {
    "event-knowledge": check_event_knowledge,
    "datafinder-interface": check_datafinder_interface,
    "metric-semantics": check_metric_semantics,
}


def main(argv: list[str] | None = None) -> int:
    args = argv if argv is not None else sys.argv[1:]
    if len(args) != 1 or args[0] not in CHECKS:
        print("usage: check_freshness.py <event-knowledge|datafinder-interface|metric-semantics>", file=sys.stderr)
        return 2
    status, messages = CHECKS[args[0]]()
    print(json.dumps({"module": args[0], "status": status, "messages": messages}, ensure_ascii=False))
    return 0 if status == "fresh" else 1


if __name__ == "__main__":
    raise SystemExit(main())
