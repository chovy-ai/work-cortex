import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url).pathname;

function readJson<T = any>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

describe("TypeScript migration contracts", () => {
  it("keeps domain module contracts", () => {
    const modules: Record<string, string> = {
      "domains/event-knowledge/module.json": "event-knowledge",
      "domains/datafinder-interface/module.json": "datafinder-interface",
      "domains/metric-semantics/module.json": "metric-semantics"
    };

    for (const [path, expectedId] of Object.entries(modules)) {
      const module = readJson<Record<string, unknown>>(path);
      expect(module.id).toBe(expectedId);
      expect(module).toHaveProperty("update");
      expect(module).toHaveProperty("check");
      expect(module).toHaveProperty("serves");
    }
  });

  it("has TypeScript target files and removes Python runtime files", () => {
    const expectedFiles = [
      "domains/event-knowledge/sync_nextop.sh",
      "domains/event-knowledge/extract_events.ts",
      "domains/datafinder-interface/client.ts",
      "domains/datafinder-interface/cli.ts",
      "domains/datafinder-interface/manifest.json",
      "domains/datafinder-interface/UPDATE.md",
      "domains/datafinder-interface/README.md",
      "domains/datafinder-interface/openapi-routing.md",
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
      "knowledge-store/event-catalog.json",
      "knowledge-store/data-model.json",
      "knowledge-store/.gitkeep",
      "outputs/.gitkeep"
    ];

    for (const path of expectedFiles) {
      expect(existsSync(join(root, path)), path).toBe(true);
    }

    const removedPaths = [
      "domains/event-knowledge/extract_events.py",
      "domains/datafinder-interface/client.py",
      "domains/datafinder-interface/cli.py",
      "domains/datafinder-interface/__init__.py",
      "domains/metric-semantics/extract_data_model.py",
      "domains/query-execution/executors/kafka_executor.py",
      "domains/query-execution/executors/local_executor.py",
      "domains/query-execution/scheduler/scheduler.py",
      "tests/test_migration_contracts.py",
      "skills/nextop-data-analytics/tools",
      "skills/nextop-data-analytics/references"
    ];

    for (const path of removedPaths) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it("keeps the event extractor on knowledge-store paths", () => {
    const source = readFileSync(join(root, "domains/event-knowledge/extract_events.ts"), "utf8");
    expect(source).toContain("knowledge-store");
    expect(source).toContain("event-catalog.json");
    expect(source).not.toContain("SKILL_ROOT");
    expect(source).not.toContain("nextop-event-catalog.json");
  });

  it("lists verified DataFinder manifest endpoints with the TypeScript CLI", () => {
    const manifest = readJson<any>("domains/datafinder-interface/manifest.json");
    expect(manifest.last_verified_against_docs_at).toBeTruthy();
    expect(manifest.endpoints.filter((ep: any) => !ep.path_verified).map((ep: any) => ep.id)).toEqual([]);

    const byId = Object.fromEntries(manifest.endpoints.map((ep: any) => [ep.id, ep]));
    const expectedProtocols: Record<string, [string, string]> = {
      "dashboard.list": ["GET", "/datafinder/openapi/v1/{app_id}/dashboards/all"],
      "analysis.download": ["POST", "/datafinder/openapi/v1/{app_id}/downloads"],
      "metadata.query": ["POST", "/datafinder/openapi/v1/metadata/{app_id}/list/events"],
      "user.query_result": ["GET", "/datafinder/openapi/v1/{app_id}/user_analysis/queries/{query_id}"],
      "segment.query": ["GET", "/datafinder/openapi/v1/{app_id}/cohorts/{cohort_id}/sample"],
      "tag.v1": ["POST", "/datatag/openapi/v1/app/{app_id}/tag/{tag_name}/download"],
      "tag.v2": ["GET", "/finder/openApi/v2/cdpMeta/labelSystem/label/historyData"],
      "raw_event.export": ["GET", "/datarangers/openapi/v1/{app_id}/exports"],
      "usage.stats": ["POST", "/datafinder/openapi/v1/usage_amount"]
    };

    for (const [endpointId, [method, path]] of Object.entries(expectedProtocols)) {
      expect(byId[endpointId].method).toBe(method);
      expect(byId[endpointId].path).toBe(path);
      expect(byId[endpointId].doc_url).toContain("volcengine.com/docs");
    }
    expect(byId["tag.v2"].header_params).toEqual({ tenant_id: "X-Tenant" });

    const output = execFileSync("npx", ["tsx", "domains/datafinder-interface/cli.ts", "list"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(output).toContain("DataFinder OpenAPI");
    expect(output).not.toContain("[path UNVERIFIED]");
  });

  it("prepares DataFinder path, query, header, and body params", async () => {
    const module = await import("../domains/datafinder-interface/client.ts");
    const client = new module.DataFinderClient({
      baseUrl: "https://analytics.volcengineapi.com",
      accessKey: "ak",
      secretKey: "sk",
      appId: 123,
      region: "cn-north-1",
      service: "datafinder",
      timeoutSeconds: 30
    });

    const captured: any[] = [];
    client.request = async (method: string, path: string, body: any, queryParams = {}, extraHeaders = {}) => {
      captured.push({ method, path, body, query: queryParams, headers: extraHeaders });
      return { status: "success" };
    };

    await client.querySegment(456, 30);
    expect(captured.at(-1)).toMatchObject({
      method: "GET",
      path: "/datafinder/openapi/v1/123/cohorts/456/sample",
      query: { count: 30 },
      body: {}
    });

    await client.queryTagV2("1", 2, "2026-06-01", "2026-06-10");
    expect(captured.at(-1).headers).toEqual({ "X-Tenant": "1" });
    expect(captured.at(-1).query.id).toBe(2);

    await client.createUserQuery("cohort", { cohort_id: 456 }, undefined, undefined, 100);
    expect(captured.at(-1).method).toBe("POST");
    expect(captured.at(-1).path).toBe("/datafinder/openapi/v1/123/user_analysis/queries");
    expect(captured.at(-1).body.query_type).toBe("cohort");
    expect(captured.at(-1).body.cohort).toEqual({ cohort_id: 456 });
  });

  it("keeps capabilities in sync with manifest", () => {
    const output = execFileSync("npx", ["tsx", "domains/knowledge-update/check_capabilities_sync.ts"], {
      cwd: root,
      encoding: "utf8"
    });
    expect(output).toContain("capabilities sync: ok");
  });

  it("persists awaiting scheduler state", async () => {
    const module = await import("../domains/query-execution/scheduler/scheduler.ts");
    const outcome = module.StepOutcome.awaitInput("user_review", { review_card: "confirm" });
    expect(outcome.status).toBe("await_input");
    const state = new module.SchedulerState("contract-test", "user_review", { run_id: "contract-test" });
    state.apply(outcome);
    expect(state.status).toBe("awaiting_input");
    expect(state.awaitingStep).toBe("user_review");
  });
});
