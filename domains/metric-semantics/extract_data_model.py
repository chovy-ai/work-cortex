#!/usr/bin/env python3
"""Extract nextop analytics data model facts into knowledge-store."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


HERE = Path(__file__).parent.resolve()
REPO_ROOT = HERE.parent.parent.parent
if REPO_ROOT.name != "data-analysis":
    REPO_ROOT = HERE.parent.parent
NEXTOP_DEFAULT = (REPO_ROOT.parent / "nextop").resolve()
OUTPUT_FILE = REPO_ROOT / "knowledge-store" / "data-model.json"

DEFAULTS_RELPATH = "config/nextop.defaults.json"
REPORTER_RELPATH = "services/nextopd/service/reporter/tea_reporter.go"
TRACKING_DOC_RELPATH = "docs/architecture/analytics-tracking.md"


def _nextop_root(override: str | None = None) -> Path:
    if override:
        return Path(override).expanduser().resolve()
    env = os.environ.get("NEXTOP_REPO_PATH")
    if env:
        return Path(env).expanduser().resolve()
    return NEXTOP_DEFAULT


def _git_commit(repo: Path) -> str:
    result = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"],
        cwd=repo,
        text=True,
        capture_output=True,
        timeout=5,
    )
    return result.stdout.strip() if result.returncode == 0 else "unknown"


def _load_defaults(nextop: Path) -> dict[str, Any]:
    path = nextop / DEFAULTS_RELPATH
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    analytics = raw.get("analytics", {})
    return {
        "appId": analytics.get("appId"),
        "appName": analytics.get("appName"),
        "channel": analytics.get("channel"),
        "channelDomain": analytics.get("channelDomain"),
        "appVersion": analytics.get("appVersion"),
        "subjectId": analytics.get("subjectId"),
        "subjectName": analytics.get("subjectName"),
    }


def _extract_go_string_list(pattern: str, content: str) -> list[str]:
    match = re.search(pattern, content, re.DOTALL)
    if not match:
        return []
    return re.findall(r'"([^"]+)"', match.group(1))


def _load_reporter_semantics(nextop: Path) -> tuple[list[str], list[str]]:
    path = nextop / REPORTER_RELPATH
    if not path.exists():
        return [], []
    content = path.read_text(encoding="utf-8")
    common = _extract_go_string_list(r"return\s+map\[string\]any\s*\{([^}]+)\}", content)
    stripped = _extract_go_string_list(r"for\s+_,\s+key\s*:=\s+range\s+\[\]string\s*\{([^}]+)\}", content)
    return common, stripped


def _load_tracking_doc(nextop: Path) -> dict[str, Any]:
    path = nextop / TRACKING_DOC_RELPATH
    if not path.exists():
        return {"path": TRACKING_DOC_RELPATH, "exists": False, "summary": ""}
    text = path.read_text(encoding="utf-8")
    headings = [line.strip("# ").strip() for line in text.splitlines() if line.startswith("#")]
    return {
        "path": TRACKING_DOC_RELPATH,
        "exists": True,
        "summary": " / ".join(headings[:6]),
    }


def build_model(nextop: Path) -> dict[str, Any]:
    common, stripped = _load_reporter_semantics(nextop)
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "nextop_commit": _git_commit(nextop),
        "nextop_path": str(nextop),
        "defaults": _load_defaults(nextop),
        "default_metric_policy": {
            "dau": {
                "identity": "device_id",
                "aggregation": "count(distinct device_id)",
                "time_bucket": "local day",
                "event_time_preference": "client_ts / local_time_ms",
            }
        },
        "nextopd_common_params": common,
        "renderer_stripped_params": stripped,
        "tracking_doc": _load_tracking_doc(nextop),
        "sources": {
            "defaults": DEFAULTS_RELPATH,
            "reporter": REPORTER_RELPATH,
            "tracking_doc": TRACKING_DOC_RELPATH,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nextop-path", help="Override path to nextop monorepo root")
    args = parser.parse_args()

    nextop = _nextop_root(args.nextop_path)
    if not nextop.exists():
        raise SystemExit(f"ERROR: nextop repo not found at {nextop}")

    model = build_model(nextop)
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(json.dumps(model, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote data model -> {OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
