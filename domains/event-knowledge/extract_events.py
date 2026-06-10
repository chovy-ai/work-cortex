#!/usr/bin/env python3
"""
Extract nextop analytics event catalog from source code.

Reads the nextop monorepo to produce a structured event catalog with:
  - event_name   : DataFinder event identifier  (e.g. "agent.message_sent")
  - params       : list of camelCase param names from the TypeScript interface
  - trigger_files: files that instantiate / call this reporter (上报时机 context)

Output: knowledge-store/event-catalog.json

Usage:
    python domains/event-knowledge/extract_events.py [--nextop-path PATH]
    NEXTOP_REPO_PATH=/path/to/nextop python domains/event-knowledge/extract_events.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).parent.resolve()
REPO_ROOT = HERE.parent.parent.parent
if REPO_ROOT.name != "data-analysis":
    REPO_ROOT = HERE.parent.parent
NEXTOP_DEFAULT = (REPO_ROOT.parent / "nextop").resolve()
OUTPUT_FILE = REPO_ROOT / "knowledge-store" / "event-catalog.json"

TS_REPORTERS_RELPATH = "apps/desktop/src/renderer/src/features/analytics/reporters"
GO_EVENTS_RELPATH = "services/nextopd/service/reporter/events"
MAIN_ANALYTICS_RELPATH = "apps/desktop/src/main"


# ── helpers ────────────────────────────────────────────────────────────────────

def _nextop_root(override: Optional[str] = None) -> Path:
    if override:
        return Path(override).expanduser().resolve()
    env = os.environ.get("NEXTOP_REPO_PATH")
    if env:
        return Path(env).expanduser().resolve()
    return NEXTOP_DEFAULT


def _git_commit(repo: Path) -> str:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, cwd=repo, timeout=5
        )
        return r.stdout.strip()
    except Exception:
        return "unknown"


TRAVERSE_EXCLUDE = [
    "--exclude-dir=node_modules", "--exclude-dir=dist",
    "--exclude-dir=.next", "--exclude-dir=out", "--exclude-dir=.git",
]


def _is_test_file(rel: str) -> bool:
    return ".test." in rel or ".spec." in rel or "__tests__" in rel


def _build_symbol_index(
    nextop: Path,
    scope_dirs: list[str],
    extensions: list[str],
    pattern: str,
) -> dict[str, list[str]]:
    """
    Single-pass reverse index: scan scoped source dirs ONCE with one grep and
    map every matched symbol → the relative files that contain it.

    This replaces O(events) full-repo greps with O(1) greps per language,
    which is the difference between ~10 minutes and a few seconds on a large repo.
    """
    include_args = [f"--include={ext}" for ext in extensions]
    dirs = [str(nextop / d) for d in scope_dirs if (nextop / d).exists()]
    if not dirs:
        return {}

    index: dict[str, set[str]] = {}
    try:
        # -r recursive, -E extended regex, -o print only the matched symbol.
        # With -r and -o, each line is "<path>:<match>".
        r = subprocess.run(
            ["grep", "-rEo"] + TRAVERSE_EXCLUDE + include_args + [pattern] + dirs,
            capture_output=True, text=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        return {}
    except Exception:
        return {}

    prefix = str(nextop) + "/"
    for line in r.stdout.splitlines():
        # Split on the LAST ':' — paths contain no ':' on this platform,
        # so "<path>:<match>" splits cleanly.
        path, _, match = line.rpartition(":")
        if not path or not match:
            continue
        rel = path.removeprefix(prefix)
        if _is_test_file(rel):
            continue
        index.setdefault(match, set()).add(rel)

    return {k: sorted(v) for k, v in index.items()}


# ── TypeScript reporter extraction ─────────────────────────────────────────────

def _ts_event_name(reporter_file: Path) -> Optional[str]:
    content = reporter_file.read_text(encoding="utf-8")
    m = re.search(
        r'(?:protected|private)\s+readonly\s+eventName\s*=\s*["\']([^"\']+)["\']',
        content
    )
    return m.group(1) if m else None


def _ts_params(types_file: Path) -> list[str]:
    if not types_file.exists():
        return []
    content = types_file.read_text(encoding="utf-8")
    m = re.search(r'interface\s+\w+Params\s+extends\s+\w+[^{]*\{([^}]+)\}', content, re.DOTALL)
    if not m:
        return []
    return re.findall(r'^\s{2}(\w+)\??:', m.group(1), re.MULTILINE)


def _ts_class_name(reporter_file: Path) -> Optional[str]:
    content = reporter_file.read_text(encoding="utf-8")
    m = re.search(r'export class (\w+)', content)
    return m.group(1) if m else None


def extract_ts_reporters(nextop: Path) -> list[dict]:
    reporters_dir = nextop / TS_REPORTERS_RELPATH
    if not reporters_dir.exists():
        return []

    # ONE grep over apps+packages for every "...Reporter" symbol occurrence.
    symbol_index = _build_symbol_index(
        nextop,
        scope_dirs=["apps", "packages"],
        extensions=["*.ts", "*.tsx"],
        pattern=r"\b[A-Z][A-Za-z0-9]*Reporter\b",
    )

    events: list[dict] = []
    for reporter_dir in sorted(reporters_dir.iterdir()):
        if not reporter_dir.is_dir():
            continue

        # Main reporter file: not index.ts, not types.ts, not a test
        candidates = [
            f for f in reporter_dir.glob("*.ts")
            if f.name not in ("index.ts", "types.ts")
            and ".test." not in f.name
            and ".spec." not in f.name
        ]
        if not candidates:
            continue
        reporter_file = candidates[0]

        event_name = _ts_event_name(reporter_file)
        if not event_name:
            continue

        params = _ts_params(reporter_dir / "types.ts")
        class_name = _ts_class_name(reporter_file)

        # Trigger files = usages of the reporter class, minus the reporters/
        # definition tree itself (its own file, index re-exports, etc.).
        trigger_files = [
            f for f in symbol_index.get(class_name or "", [])
            if "analytics/reporters" not in f
        ]

        events.append({
            "event_name": event_name,
            "params": params,
            "trigger_files": trigger_files,
        })

    return events


# ── Go event extraction ────────────────────────────────────────────────────────

def extract_go_events(nextop: Path) -> list[dict]:
    events_dir = nextop / GO_EVENTS_RELPATH
    if not events_dir.exists():
        return []

    # ONE grep for every reporter-event import path reference across .go files.
    # Callers import each event package by its full path, e.g.
    #   ".../reporter/events/agent/message_sent"
    # The tail after "reporter/events/" uniquely identifies the event package,
    # avoiding the basename collisions (e.g. multiple "opened") that a bare
    # package-name grep would hit.
    path_index = _build_symbol_index(
        nextop,
        scope_dirs=["services", "packages", "apps"],
        extensions=["*.go"],
        pattern=r"reporter/events/[a-zA-Z0-9_/]+",
    )

    events: list[dict] = []
    for event_go in sorted(events_dir.rglob("event.go")):
        content = event_go.read_text(encoding="utf-8")
        m = re.search(
            r'reporterevents\.Track\([^,]+,\s*[^,]+,\s*"([^"]+)"',
            content
        )
        if not m:
            continue
        event_name = m.group(1)

        # Package path tail relative to the events dir, e.g. "agent/message_sent".
        pkg_rel = event_go.parent.relative_to(events_dir).as_posix()
        import_tail = f"reporter/events/{pkg_rel}"

        trigger_files = [
            f for f in path_index.get(import_tail, [])
            if not f.endswith("event.go")
        ]

        events.append({
            "event_name": event_name,
            "params": [],
            "trigger_files": trigger_files,
        })

    return events


# ── Main-process (Electron) event extraction ───────────────────────────────────

def extract_main_process_events(nextop: Path) -> list[dict]:
    main_dir = nextop / MAIN_ANALYTICS_RELPATH
    if not main_dir.exists():
        return []

    events: list[dict] = []
    for analytics_file in sorted(main_dir.glob("*Analytics.ts")):
        content = analytics_file.read_text(encoding="utf-8")
        # name: "event.name" inside trackEvents / createXxxEvent calls
        names = re.findall(r'\bname:\s*["\']([a-z][a-z0-9_.]+[a-z0-9])["\']', content)
        rel = str(analytics_file).removeprefix(str(nextop) + "/")
        for name in dict.fromkeys(names):  # deduplicate, preserve order
            events.append({
                "event_name": name,
                "params": [],
                "trigger_files": [rel],
            })

    return events


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Extract nextop analytics event catalog")
    parser.add_argument("--nextop-path", help="Override path to nextop monorepo root")
    args = parser.parse_args()

    nextop = _nextop_root(args.nextop_path)
    if not nextop.exists():
        raise SystemExit(
            f"ERROR: nextop repo not found at {nextop}\n"
            f"Run domains/event-knowledge/sync_nextop.sh first, or set NEXTOP_REPO_PATH."
        )

    print(f"Scanning: {nextop}")

    ts_events = extract_ts_reporters(nextop)
    go_events = extract_go_events(nextop)
    main_events = extract_main_process_events(nextop)

    # Merge all three sources by event_name. An event may surface in more than
    # one source (a TS reporter, a Go mirror, a main-process call site); union
    # their trigger files and keep the richest param list so 上报时机 from the
    # main process is not lost just because a same-named TS reporter exists.
    merged: dict[str, dict] = {}
    n_ts = n_go_only = n_main_only = 0
    for source, events in (("ts", ts_events), ("go", go_events), ("main", main_events)):
        for e in events:
            name = e["event_name"]
            if name not in merged:
                merged[name] = {"event_name": name, "params": [], "trigger_files": []}
                if source == "go":
                    n_go_only += 1
                elif source == "main":
                    n_main_only += 1
            entry = merged[name]
            if e["params"] and not entry["params"]:
                entry["params"] = e["params"]
            for f in e["trigger_files"]:
                if f not in entry["trigger_files"]:
                    entry["trigger_files"].append(f)
    n_ts = len(ts_events)

    for entry in merged.values():
        entry["trigger_files"].sort()

    all_events = sorted(merged.values(), key=lambda e: e["event_name"])
    print(f"  TypeScript reporters : {n_ts}")
    print(f"  Go-only events       : {n_go_only}")
    print(f"  Main-process-only    : {n_main_only}")

    catalog = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "nextop_commit": _git_commit(nextop),
        "nextop_path": str(nextop),
        "total_events": len(all_events),
        "events": all_events,
    }

    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_FILE.write_text(
        json.dumps(catalog, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8"
    )
    print(f"\nWrote {len(all_events)} events → {OUTPUT_FILE}")
    print("\nSample (first 5):")
    for e in all_events[:5]:
        triggers = e["trigger_files"][:1]
        print(f"  {e['event_name']}")
        if e.get("params"):
            print(f"    params       : {', '.join(e['params'])}")
        if triggers:
            print(f"    triggered at : {triggers[0]}")


if __name__ == "__main__":
    main()
