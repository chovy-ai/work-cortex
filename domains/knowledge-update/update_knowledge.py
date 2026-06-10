#!/usr/bin/env python3
"""Control plane for data-analysis knowledge module updates."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
REGISTRY = ROOT / "domains" / "knowledge-update" / "registry.json"


def discover_modules() -> list[dict[str, Any]]:
    modules = []
    for module_path in sorted((ROOT / "domains").glob("*/module.json")):
        modules.append(json.loads(module_path.read_text(encoding="utf-8")))
    return modules


def write_registry(modules: list[dict[str, Any]]) -> None:
    payload = {
        "modules": [
            {
                "id": module["id"],
                "path": str((ROOT / "domains" / module["id"] / "module.json").relative_to(ROOT)),
                "serves": module.get("serves", []),
            }
            for module in modules
        ]
    }
    REGISTRY.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def run_status(modules: list[dict[str, Any]]) -> int:
    exit_code = 0
    for module in modules:
        check = module.get("check", {})
        if check.get("type") != "script" or not check.get("cmd"):
            print(f"{module['id']}: unknown (no script check)")
            exit_code = 1
            continue
        result = subprocess.run(check["cmd"], cwd=ROOT, shell=True, text=True, capture_output=True)
        line = result.stdout.strip() or result.stderr.strip()
        try:
            payload = json.loads(line)
            status = payload.get("status", "unknown")
            messages = "; ".join(payload.get("messages", []))
        except json.JSONDecodeError:
            status = "unknown"
            messages = line
        print(f"{module['id']}: {status}" + (f" - {messages}" if messages else ""))
        if status != "fresh":
            exit_code = 1
    return exit_code


def run_update(modules: list[dict[str, Any]], target: str) -> int:
    selected = modules if target == "all" else [module for module in modules if module["id"] == target]
    if not selected:
        print(f"unknown module: {target}", file=sys.stderr)
        return 2

    exit_code = 0
    for module in selected:
        update = module.get("update", {})
        if update.get("type") == "script":
            result = subprocess.run(update["cmd"], cwd=ROOT, shell=True)
            if result.returncode != 0:
                exit_code = result.returncode
        elif update.get("type") == "agent":
            print(f"{module['id']}: agent update required")
            print(f"procedure: {update.get('procedure')}")
            links = module.get("doc_links", [])
            if links:
                print("doc_links:")
                for link in links:
                    print(f"  - {link}")
        else:
            print(f"{module['id']}: unknown update type", file=sys.stderr)
            exit_code = 1
    return exit_code


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("status")
    update = sub.add_parser("update")
    update.add_argument("target")
    sub.add_parser("register")
    args = parser.parse_args(argv)

    modules = discover_modules()
    if args.command == "register":
        write_registry(modules)
        print(f"registered {len(modules)} modules")
        return 0
    if args.command == "status":
        return run_status(modules)
    if args.command == "update":
        return run_update(modules, args.target)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
