from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from unittest import TestCase, main


ROOT = Path(__file__).resolve().parents[1]


def load_json(path: str) -> dict:
    return json.loads((ROOT / path).read_text(encoding="utf-8"))


def load_module(name: str, rel_path: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel_path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class MigrationContractsTest(TestCase):
    def test_domain_module_contracts_exist(self) -> None:
        modules = {
            "domains/event-knowledge/module.json": "event-knowledge",
            "domains/datafinder-interface/module.json": "datafinder-interface",
            "domains/metric-semantics/module.json": "metric-semantics",
        }

        for rel_path, expected_id in modules.items():
            with self.subTest(rel_path=rel_path):
                module = load_json(rel_path)
                self.assertEqual(module["id"], expected_id)
                self.assertIn("update", module)
                self.assertIn("check", module)
                self.assertIn("serves", module)

    def test_target_files_exist_and_legacy_files_are_removed(self) -> None:
        expected_files = [
            "domains/event-knowledge/sync_nextop.sh",
            "domains/event-knowledge/extract_events.py",
            "domains/datafinder-interface/client.py",
            "domains/datafinder-interface/cli.py",
            "domains/datafinder-interface/manifest.json",
            "domains/datafinder-interface/UPDATE.md",
            "domains/datafinder-interface/README.md",
            "domains/datafinder-interface/openapi-routing.md",
            "domains/metric-semantics/data-model-protocol.md",
            "domains/metric-semantics/extract_data_model.py",
            "domains/intent-routing/capabilities.json",
            "domains/intent-routing/capability-inventory.md",
            "domains/intent-routing/query-intent-protocol.md",
            "domains/intent-routing/query-intent.schema.json",
            "domains/query-execution/executors/kafka_executor.py",
            "domains/query-execution/executors/local_executor.py",
            "domains/query-execution/scheduler/workflow.json",
            "domains/query-execution/scheduler/scheduler.py",
            "domains/knowledge-update/update_knowledge.py",
            "domains/knowledge-update/check_freshness.py",
            "domains/knowledge-update/check_capabilities_sync.py",
            "knowledge-store/event-catalog.json",
            "knowledge-store/data-model.json",
            "knowledge-store/.gitkeep",
            "outputs/.gitkeep",
        ]
        for rel_path in expected_files:
            with self.subTest(rel_path=rel_path):
                self.assertTrue((ROOT / rel_path).exists(), rel_path)

        removed_paths = [
            "skills/nextop-data-analytics/tools",
            "skills/nextop-data-analytics/references",
            "skills/nextop-data-analytics/tools/datafinder_client.py",
            "skills/nextop-data-analytics/ARCHITECTURE.md",
            "skills/nextop-data-analytics/DOMAIN-DESIGN.md",
            "skills/nextop-data-analytics/EXECUTION-FLOW.md",
        ]
        for rel_path in removed_paths:
            with self.subTest(rel_path=rel_path):
                self.assertFalse((ROOT / rel_path).exists(), rel_path)

    def test_event_extractor_uses_new_store_paths(self) -> None:
        source = (ROOT / "domains/event-knowledge/extract_events.py").read_text(encoding="utf-8")
        self.assertIn('REPO_ROOT = HERE.parent.parent.parent', source)
        self.assertIn('REPO_ROOT / "knowledge-store" / "event-catalog.json"', source)
        self.assertNotIn("SKILL_ROOT", source)
        self.assertNotIn('"references" / "common" / "nextop-event-catalog.json"', source)

    def test_datafinder_manifest_is_verified_and_cli_lists_without_legacy_package(self) -> None:
        manifest = load_json("domains/datafinder-interface/manifest.json")
        self.assertTrue(manifest["last_verified_against_docs_at"])
        unverified = [ep["id"] for ep in manifest["endpoints"] if not ep.get("path_verified")]
        self.assertEqual(unverified, [])

        by_id = {ep["id"]: ep for ep in manifest["endpoints"]}
        expected_protocols = {
            "dashboard.list": ("GET", "/datafinder/openapi/v1/{app_id}/dashboards/all"),
            "analysis.download": ("POST", "/datafinder/openapi/v1/{app_id}/downloads"),
            "metadata.query": ("POST", "/datafinder/openapi/v1/metadata/{app_id}/list/events"),
            "user.query_result": ("GET", "/datafinder/openapi/v1/{app_id}/user_analysis/queries/{query_id}"),
            "segment.query": ("GET", "/datafinder/openapi/v1/{app_id}/cohorts/{cohort_id}/sample"),
            "tag.v1": ("POST", "/datatag/openapi/v1/app/{app_id}/tag/{tag_name}/download"),
            "tag.v2": ("GET", "/finder/openApi/v2/cdpMeta/labelSystem/label/historyData"),
            "raw_event.export": ("GET", "/datarangers/openapi/v1/{app_id}/exports"),
            "usage.stats": ("POST", "/datafinder/openapi/v1/usage_amount"),
        }
        for endpoint_id, (method, path) in expected_protocols.items():
            with self.subTest(endpoint_id=endpoint_id):
                self.assertEqual(by_id[endpoint_id]["method"], method)
                self.assertEqual(by_id[endpoint_id]["path"], path)
                self.assertIn("volcengine.com/docs", by_id[endpoint_id]["doc_url"])
        self.assertEqual(by_id["tag.v2"]["header_params"], {"tenant_id": "X-Tenant"})

        result = subprocess.run(
            [sys.executable, "domains/datafinder-interface/cli.py", "list"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DataFinder OpenAPI", result.stdout)
        self.assertNotIn("[path UNVERIFIED]", result.stdout)

    def test_datafinder_client_prepares_path_query_header_and_body_params(self) -> None:
        module = load_module("datafinder_client_contract", "domains/datafinder-interface/client.py")
        config = module.DataFinderConfig(
            base_url="https://analytics.volcengineapi.com",
            access_key="ak",
            secret_key="sk",
            app_id=123,
        )
        client = module.DataFinderClient(config)
        captured = []

        def fake_request(method, path, body, query_params=None, extra_headers=None):
            captured.append({
                "method": method,
                "path": path,
                "body": body,
                "query": query_params or {},
                "headers": extra_headers or {},
            })
            return module.APIResult(status="success")

        client._request = fake_request

        client.query_segment(cohort_id=456, count=30)
        self.assertEqual(captured[-1]["method"], "GET")
        self.assertEqual(captured[-1]["path"], "/datafinder/openapi/v1/123/cohorts/456/sample")
        self.assertEqual(captured[-1]["query"], {"count": 30})
        self.assertEqual(captured[-1]["body"], {})

        client.query_tag_v2(tenant_id="1", tag_id=2, start_date="2026-06-01", end_date="2026-06-10")
        self.assertEqual(captured[-1]["method"], "GET")
        self.assertEqual(captured[-1]["path"], "/finder/openApi/v2/cdpMeta/labelSystem/label/historyData")
        self.assertEqual(captured[-1]["headers"], {"X-Tenant": "1"})
        self.assertEqual(captured[-1]["query"]["id"], 2)

        client.create_user_query("cohort", {"cohort_id": 456}, limit=100)
        self.assertEqual(captured[-1]["method"], "POST")
        self.assertEqual(captured[-1]["path"], "/datafinder/openapi/v1/123/user_analysis/queries")
        self.assertEqual(captured[-1]["body"]["query_type"], "cohort")
        self.assertEqual(captured[-1]["body"]["cohort"], {"cohort_id": 456})

    def test_capabilities_are_in_sync_with_manifest(self) -> None:
        result = subprocess.run(
            [sys.executable, "domains/knowledge-update/check_capabilities_sync.py"],
            cwd=ROOT,
            text=True,
            capture_output=True,
            timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("capabilities sync: ok", result.stdout)

    def test_scheduler_persists_awaiting_state(self) -> None:
        module = load_module("scheduler_contract", "domains/query-execution/scheduler/scheduler.py")

        ctx = {"run_id": "contract-test", "query_path": "raw_analysis"}
        outcome = module.StepOutcome.await_input("user_review", {"review_card": "confirm"})
        self.assertEqual(outcome.status, "await_input")
        state = module.SchedulerState(run_id=ctx["run_id"], current_step="user_review", context=ctx)
        state.apply(outcome)
        self.assertEqual(state.status, "awaiting_input")
        self.assertEqual(state.awaiting_step, "user_review")


if __name__ == "__main__":
    main()
