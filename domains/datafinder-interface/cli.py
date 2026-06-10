#!/usr/bin/env python3
"""
DataFinder OpenAPI module CLI — discovery and ad-hoc calls.

Discovery (no credentials needed):
    python3 domains/datafinder-interface/cli.py list
    python3 domains/datafinder-interface/cli.py describe report.query

Invocation (reads .env.local for credentials):
    python3 domains/datafinder-interface/cli.py call dashboard.list
    python3 domains/datafinder-interface/cli.py call report.query --params '{"report_id":"123","period":{"start_time":"2026-06-01","end_time":"2026-06-07"}}'
"""

from __future__ import annotations

import argparse
import json
import sys

if __package__:
    from .client import DataFinderClient, EndpointNotFound, load_config_from_env, load_manifest
else:
    from client import DataFinderClient, EndpointNotFound, load_config_from_env, load_manifest


def _cmd_list(_args: argparse.Namespace) -> int:
    manifest = load_manifest()
    print(f"DataFinder OpenAPI — {len(manifest['endpoints'])} endpoints "
          f"(doc root: {manifest['global']['doc_root']})\n")
    for ep in manifest["endpoints"]:
        flag = "" if ep.get("path_verified") else "  [path UNVERIFIED]"
        print(f"  {ep['id']:<22} {ep['summary']}{flag}")
    return 0


def _cmd_describe(args: argparse.Namespace) -> int:
    manifest = load_manifest()
    by_id = {ep["id"]: ep for ep in manifest["endpoints"]}
    ep = by_id.get(args.endpoint_id)
    if ep is None:
        print(f"Unknown endpoint '{args.endpoint_id}'.", file=sys.stderr)
        print(f"Known: {', '.join(sorted(by_id))}", file=sys.stderr)
        print(f"To add it, see UPDATE.md and the docs: {manifest['global']['doc_root']}",
              file=sys.stderr)
        return 1
    print(json.dumps(ep, indent=2, ensure_ascii=False))
    return 0


def _cmd_call(args: argparse.Namespace) -> int:
    params = json.loads(args.params) if args.params else {}
    config = load_config_from_env(args.env)
    client = DataFinderClient(config)
    try:
        result = client.call(args.endpoint_id, params)
    except EndpointNotFound as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(json.dumps({
        "status": result.status,
        "endpoint_id": result.endpoint_id,
        "http_status": result.http_status,
        "error_code": result.error_code,
        "error_message": result.error_message,
        "warnings": result.warnings,
        "data": result.data,
    }, indent=2, ensure_ascii=False, default=str))
    return 0 if result.status == "success" else 2


def main() -> int:
    parser = argparse.ArgumentParser(prog="datafinder.cli", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List all declared endpoints")
    p_list.set_defaults(func=_cmd_list)

    p_desc = sub.add_parser("describe", help="Show one endpoint's full interface spec")
    p_desc.add_argument("endpoint_id")
    p_desc.set_defaults(func=_cmd_describe)

    p_call = sub.add_parser("call", help="Call one endpoint (reads .env.local)")
    p_call.add_argument("endpoint_id")
    p_call.add_argument("--params", help="JSON object of request params")
    p_call.add_argument("--env", help="Path to .env.local (default: project root)")
    p_call.set_defaults(func=_cmd_call)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
