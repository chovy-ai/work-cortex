#!/usr/bin/env python3
"""Check that DataFinder manifest endpoint capabilities are represented."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "domains" / "datafinder-interface" / "manifest.json"
CAPABILITIES = ROOT / "domains" / "intent-routing" / "capabilities.json"


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    manifest = _load(MANIFEST)
    capabilities = _load(CAPABILITIES)
    manifest_ids = {
        ep["capability_id"]
        for ep in manifest.get("endpoints", [])
        if ep.get("capability_id")
    }
    capability_ids = {
        item["capability_id"]
        for item in capabilities.get("capabilities", [])
        if item.get("capability_id", "").startswith("datafinder.openapi.")
    }

    missing = sorted(manifest_ids - capability_ids)
    extra = sorted(capability_ids - manifest_ids)

    if missing or extra:
        print("capabilities sync: stale")
        if missing:
            print("missing in capabilities.json:")
            for item in missing:
                print(f"  - {item}")
        if extra:
            print("not backed by manifest.json:")
            for item in extra:
                print(f"  - {item}")
        return 1

    print(f"capabilities sync: ok ({len(manifest_ids)} OpenAPI capabilities)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
