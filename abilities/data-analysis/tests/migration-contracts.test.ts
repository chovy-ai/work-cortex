import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { SchedulerState, StepOutcome } from "../domains/query-execution/scheduler/scheduler.js";

// Compiled location: build/tests/migration-contracts.test.js — the repo root
// is two levels up from this file.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

function load_json(rel_path: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(ROOT, rel_path), "utf-8"));
}

test("test_domain_module_contracts_exist", async (t) => {
  const modules: Record<string, string> = {
    "domains/event-knowledge/module.json": "event-knowledge",
    "domains/metric-semantics/module.json": "metric-semantics",
  };

  for (const [rel_path, expected_id] of Object.entries(modules)) {
    await t.test(`rel_path=${rel_path}`, () => {
      const module = load_json(rel_path);
      assert.equal(module["id"], expected_id);
      assert.ok("update" in module);
      assert.ok("check" in module);
      assert.ok("serves" in module);
    });
  }
});

test("test_target_files_exist_and_legacy_files_are_removed", async (t) => {
  const expected_files = [
    "domains/event-knowledge/sync_app.sh",
    "domains/event-knowledge/extract_events.ts",
    "domains/datafinder-interface/cli.ts",
    "domains/metric-semantics/data-model-protocol.md",
    "domains/metric-semantics/extract_data_model.ts",
    "domains/intent-routing/capabilities.json",
    "domains/intent-routing/capability-inventory.md",
    "domains/intent-routing/query-intent-protocol.md",
    "domains/intent-routing/query-intent.schema.json",
    "domains/query-execution/executors/kafka_executor.ts",
    "domains/query-execution/executors/local_executor.ts",
    "domains/query-execution/scheduler/workflow.json",
    "domains/query-execution/scheduler/scheduler.ts",
    "domains/knowledge-update/update_knowledge.ts",
    "domains/knowledge-update/check_freshness.ts",
    "domains/knowledge-update/check_capabilities_sync.ts",
    "knowledge-store/.gitkeep",
    "outputs/.gitkeep",
  ];
  for (const rel_path of expected_files) {
    await t.test(`rel_path=${rel_path}`, () => {
      assert.ok(existsSync(path.join(ROOT, rel_path)), rel_path);
    });
  }

  const removed_paths = [
    "skills/data-analytics/tools",
    "skills/data-analytics/references",
    "skills/data-analytics/tools/datafinder_client.py",
    "skills/data-analytics/ARCHITECTURE.md",
    "skills/data-analytics/DOMAIN-DESIGN.md",
    "skills/data-analytics/EXECUTION-FLOW.md",
  ];
  for (const rel_path of removed_paths) {
    await t.test(`rel_path=${rel_path}`, () => {
      assert.ok(!existsSync(path.join(ROOT, rel_path)), rel_path);
    });
  }
});

test("test_event_extractor_uses_new_store_paths", () => {
  const source = readFileSync(path.join(ROOT, "domains/event-knowledge/extract_events.ts"), "utf-8");
  // Output path is now config-driven via app.config.json (output.eventCatalog),
  // resolved through the central loader instead of a hardcoded string.
  assert.ok(source.includes("resolveOutput(CONFIG.output.eventCatalog"));
  assert.ok(!source.includes("SKILL_ROOT"));

  // The configured output still lands under knowledge-store/ — the guarantee
  // the original assertion was protecting. Read the committed template
  // (app.config.json is gitignored / local-only).
  const appConfig = load_json("app.config.example.json");
  assert.equal(appConfig["output"]["eventCatalog"], "knowledge-store/event-catalog.json");
  assert.equal(appConfig["output"]["dataModel"], "knowledge-store/data-model.json");
});

test("test_datafinder_manifest_is_verified_and_cli_lists_without_legacy_package", async (t) => {
  // manifest 已抽离到独立包 @workcortex/datafinder-sdk（单一真源）。
  const manifest = load_json("../../packages/datafinder-sdk/manifest.json");
  assert.ok(manifest["last_verified_against_docs_at"]);
  const unverified = (manifest["endpoints"] as Record<string, any>[])
    .filter((ep) => !ep["path_verified"])
    .map((ep) => ep["id"]);
  assert.deepEqual(unverified, []);

  const by_id: Record<string, Record<string, any>> = {};
  for (const ep of manifest["endpoints"] as Record<string, any>[]) {
    by_id[ep["id"]] = ep;
  }
  const expected_protocols: Record<string, [string, string]> = {
    "dashboard.list": ["GET", "/datafinder/openapi/v1/{app_id}/dashboards/all"],
    "analysis.download": ["POST", "/datafinder/openapi/v1/{app_id}/downloads"],
    "metadata.query": ["POST", "/datafinder/openapi/v1/metadata/{app_id}/list/events"],
    "user.query_result": ["GET", "/datafinder/openapi/v1/{app_id}/user_analysis/queries/{query_id}"],
    "segment.query": ["GET", "/datafinder/openapi/v1/{app_id}/cohorts/{cohort_id}/sample"],
    "tag.v1": ["POST", "/datatag/openapi/v1/app/{app_id}/tag/{tag_name}/download"],
    "tag.v2": ["GET", "/finder/openApi/v2/cdpMeta/labelSystem/label/historyData"],
    "raw_event.export": ["GET", "/datarangers/openapi/v1/{app_id}/exports"],
    "usage.stats": ["POST", "/datafinder/openapi/v1/usage_amount"],
  };
  for (const [endpoint_id, [method, expected_path]] of Object.entries(expected_protocols)) {
    await t.test(`endpoint_id=${endpoint_id}`, () => {
      assert.equal(by_id[endpoint_id]["method"], method);
      assert.equal(by_id[endpoint_id]["path"], expected_path);
      assert.ok(String(by_id[endpoint_id]["doc_url"]).includes("volcengine.com/docs"));
    });
  }
  assert.deepEqual(by_id["tag.v2"]["header_params"], { tenant_id: "X-Tenant" });

  const result = spawnSync("node", ["build/domains/datafinder-interface/cli.js", "list"], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("DataFinder OpenAPI"));
  assert.ok(!result.stdout.includes("[path UNVERIFIED]"));
});

test("test_datafinder_client_prepares_path_query_header_and_body_params", async () => {
  const { DataFinderClient } = await import("@workcortex/datafinder-sdk");
  const client = new DataFinderClient({
    base_url: "https://analytics.volcengineapi.com",
    access_key: "ak",
    secret_key: "sk",
    app_id: 123,
  });
  const captured: Record<string, any>[] = [];
  (client as any).request = async (
    method: string,
    reqPath: string,
    body: Record<string, unknown>,
    queryParams?: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ) => {
    captured.push({ method, path: reqPath, body, query: queryParams ?? {}, headers: extraHeaders ?? {} });
    return { status: "success", warnings: [] };
  };

  await client.querySegment(456, 30);
  assert.equal(captured.at(-1)!["method"], "GET");
  assert.equal(captured.at(-1)!["path"], "/datafinder/openapi/v1/123/cohorts/456/sample");
  assert.deepEqual(captured.at(-1)!["query"], { count: 30 });
  assert.deepEqual(captured.at(-1)!["body"], {});

  await client.queryTagV2("1", 2, "2026-06-01", "2026-06-10");
  assert.equal(captured.at(-1)!["method"], "GET");
  assert.equal(captured.at(-1)!["path"], "/finder/openApi/v2/cdpMeta/labelSystem/label/historyData");
  assert.deepEqual(captured.at(-1)!["headers"], { "X-Tenant": "1" });
  assert.equal(captured.at(-1)!["query"]["id"], 2);

  await client.createUserQuery("cohort", { cohort_id: 456 }, undefined, undefined, 100);
  assert.equal(captured.at(-1)!["method"], "POST");
  assert.equal(captured.at(-1)!["path"], "/datafinder/openapi/v1/123/user_analysis/queries");
  assert.equal(captured.at(-1)!["body"]["query_type"], "cohort");
  assert.deepEqual(captured.at(-1)!["body"]["cohort"], { cohort_id: 456 });
});

test("test_capabilities_are_in_sync_with_manifest", () => {
  const result = spawnSync("node", ["build/domains/knowledge-update/check_capabilities_sync.js"], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(result.stdout.includes("capabilities sync: ok"));
});

test("test_scheduler_persists_awaiting_state", () => {
  const ctx: Record<string, any> = { run_id: "contract-test", query_path: "raw_analysis" };
  const outcome = StepOutcome.await_input("user_review", { review_card: "confirm" });
  assert.equal(outcome.status, "await_input");
  const state = new SchedulerState({ run_id: ctx["run_id"], current_step: "user_review", context: ctx });
  state.apply(outcome);
  assert.equal(state.status, "awaiting_input");
  assert.equal(state.awaiting_step, "user_review");
});
