---
name: nextop-data-analytics
description: Analyze nextop product analytics data from 火山引擎 DataFinder OpenAPI, DataFinder Kafka exports, CSV/NDJSON samples, or copied dashboard results. Use when users ask for nextop DAU/WAU/MAU, active growth, retention, funnel, feature usage, event debugging, user behavior flow, DataFinder OpenAPI selection, or analytics data interpretation.
---

# Nextop Data Analytics

## Workflow

### Phase 0 — Sync & Index (run once per session, or when event data feels stale)

1. **Update nextop code**: Run `bash domains/event-knowledge/sync_nextop.sh` to pull the latest nextop monorepo. Skip if the user has confirmed the local copy is current.
2. **Build event catalog**: Run `python3 domains/event-knowledge/extract_events.py` to regenerate `knowledge-store/event-catalog.json`. The catalog contains every registered analytics event with its parameter names and the source files where the event fires (上报时机). Skip if the catalog already exists and the user has not requested a refresh.
3. **Read the catalog**: Load `knowledge-store/event-catalog.json` into context. Each entry has:
   - `event_name` — the DataFinder event identifier (e.g. `agent.message_sent`)
   - `params` — list of parameter names the event carries
   - `trigger_files` — source files that call the reporter (use file paths to infer 上报时机)

The catalog is the authoritative event source for this session. Do not call the DataFinder metadata API for event discovery unless the catalog is unavailable.

---

### Phase 1 — Understand & Classify

1. Clarify the analysis target: metric, time range, timezone, breakdown dimensions, expected output, and whether the user wants a factual query result or an analytical explanation.
2. Inventory callable capabilities before routing. Read `domains/intent-routing/capability-inventory.md` first and use `domains/intent-routing/capabilities.json` as the machine-readable source of CapabilitySpec truth.
3. Ground the QueryIntent in real assets:
   - **Event knowledge**: Use the event catalog from Phase 0 to validate event names and understand 上报时机. Do not invent event names not present in the catalog. Note that `trigger_files` may be empty for events dispatched indirectly (variable event name, factory/registry) — the event is still real.
   - **Dashboard list**: Call `dashboard.list` via the DataFinder module (`domains/datafinder-interface/`) to retrieve available dashboards and reports with their ids and names. Required when the user references a dashboard by name or when `query_path` may be `dashboard`. See "DataFinder OpenAPI module" below.
   - If OpenAPI config is not yet available, proceed without the dashboard list and flag unresolved dashboard names in `QueryIntent.warnings`. Event grounding still works from the local catalog.
4. Convert natural language into a CapabilitySpec-bound QueryIntent. Read `domains/intent-routing/query-intent-protocol.md` and validate shape against `domains/intent-routing/query-intent.schema.json`. The intent **must** include a `query_path` field — either `dashboard` or `raw_analysis` — which drives the route in Phase 2. Use the event catalog to validate event names and the dashboard list to resolve dashboard ids.

### Phase 2 — Route by Query Path

---

#### Path A — Dashboard / Chart Query (`query_path: dashboard`)

Use when the user references an existing DataFinder dashboard, report, or saved chart, or provides a `report_id` / `dashboard_id`. The metric definition and calculation logic live entirely inside the DataFinder asset; this path only supplies a time range override. No review gate is required.

4A. Confirm `report_id` or `dashboard_id` from the QueryIntent slots. If missing, search for the dashboard by name using `dashboard.list` / `dashboard.reports` in the DataFinder module (`domains/datafinder-interface/`). See "DataFinder OpenAPI module" below for endpoint discovery.
5A. Convert matched QueryIntent into QueryPlan. Read `domains/query-execution/protocols/dashboard/query-plan-protocol.md`. Resolve the time range to absolute dates and validate required slots (`asset_id`, `time_range`). Do not expand metric definitions or apply event selection logic — those are owned by the asset.
6A. Compile QueryPlan into an executable request plan. Read `domains/query-execution/protocols/dashboard/compiled-query-protocol.md`. The request body carries only `asset_id` and the resolved time range.
7A. Execute the compiled query and return ExecutionResult. Read `domains/query-execution/protocols/dashboard/execution-result-protocol.md`.
8A. Return the result. Report the asset id, time range used, and any result caveats.

---

#### Path B — Raw Data Analysis (`query_path: raw_analysis`)

Use when the model must decide which events to include, how to define the metric, or what calculation logic to apply. Because the model makes semantic decisions, this path requires a two-stage review gate before execution.

4B. Apply nextop-specific defaults from `domains/metric-semantics/data-model-protocol.md`.
5B. Select the data path:
    - Use the DataFinder OpenAPI module (`domains/datafinder-interface/`) for event analysis DSL, user profiles, behavior flows, user list queries, tags, and export downloads. See "DataFinder OpenAPI module" below. Use `domains/datafinder-interface/openapi-routing.md` for higher-level routing rules.
    - Use Kafka or exported raw events when the request needs raw event reconstruction, custom identity logic, near-real-time streams, or fields unavailable from OpenAPI. Read `domains/query-execution/protocols/raw-analysis/datafinder-kafka-raw-events.md` first.
    - Use local CSV/NDJSON files when the user provides extracted data.
6B. **Subagent Review (automated)**: Spawn a review subagent with the QueryIntent. Read `domains/query-execution/protocols/raw-analysis/review-protocol.md` — Stage 1 — for the full protocol. The subagent validates event semantics, identity key, aggregation logic, filter safety, breakdown validity, and known risks. If the review returns `requires_revision`, revise the QueryIntent and re-run (max 2 retries before escalating to the user). Do not proceed to Step 7B until review status is `approved`.
7B. **User Review (human confirmation)**: Present a `ReviewCard` to the user. Read `domains/query-execution/protocols/raw-analysis/review-protocol.md` — Stage 2 — for the exact card format. The card shows the calculation formula, event set, time range, applied defaults, and any warnings. **Do not execute anything until the user explicitly confirms.** If the user requests changes, return to Step 3 with the revised intent.
8B. Convert the confirmed QueryIntent into QueryPlan. Read `domains/query-execution/protocols/raw-analysis/query-plan-protocol.md` and validate shape against `domains/query-execution/protocols/raw-analysis/query-plan.schema.json`.
9B. Compile QueryPlan into an executable request plan. Read `domains/query-execution/protocols/raw-analysis/compiled-query-protocol.md` and validate shape against `domains/query-execution/protocols/raw-analysis/compiled-query.schema.json`.
10B. Execute the compiled query and return ExecutionResult. Read `domains/query-execution/protocols/raw-analysis/execution-result-protocol.md` and validate shape against `domains/query-execution/protocols/raw-analysis/execution-result.schema.json`.
11B. Validate result quality: row count, date coverage, `app_id`, timezone, null identity rate, duplicate rate, and whether server/client time differs materially. Report results with the exact metric definition, query inputs, commands or API path used, and remaining uncertainty.

## Default Metric Policy

- For DAU, default to `count(distinct device_id)` by local day for nextop app events.
- Prefer event occurrence time (`client_ts` in nextop protocol, mapped into DataFinder event local time / `local_time_ms`) over ingestion time (`server_time`) unless diagnosing delivery delay.
- Filter to the configured nextop DataFinder app before aggregating.
- Treat nextopd-owned common params as authoritative: `device_id`, `session_id`, `app_version`, `os`.
- Do not trust renderer-supplied params with the same names; nextopd strips those before forwarding and injects its own values.
- Exclude no events by default. If the user asks for "meaningful active users", propose an event include/exclude list and explain the impact before applying it.

## DataFinder OpenAPI module

All DataFinder OpenAPI calls go through the self-contained module at `domains/datafinder-interface/`. It bundles the calling logic, the complete interface definitions, the official doc URLs, and a self-update procedure in one place. Read `domains/datafinder-interface/README.md` for the full interface.

**Discover the interface** (no credentials needed):

```
cd tools
python3 domains/datafinder-interface/cli.py list                 # every endpoint + summary
python3 domains/datafinder-interface/cli.py describe <endpoint>  # one endpoint's full spec + doc URL
```

`manifest.json` is the canonical, machine-readable definition of every endpoint (method, path, required/optional params, response shape, limits, doc URL).

**Call an endpoint** (reads `.env.local`):

```python
from datafinder import DataFinderClient, load_config_from_env
client = DataFinderClient(load_config_from_env())
result = client.call("dashboard.list", {})            # generic, manifest-validated
result = client.query_report(report_id="…", start_date="…", end_date="…")  # typed wrapper
```

**When an endpoint is missing or its path is unverified**: `call()` on an unknown id returns `error_code: "endpoint_not_in_manifest"`, and entries with `"path_verified": false` emit a warning. In both cases, look up the latest interface in the official docs and extend `manifest.json` following `domains/datafinder-interface/UPDATE.md`. After registration the endpoint is immediately callable. Run this update procedure whenever the docs have changed, a path returns 404, or the user asks to refresh the DataFinder interface.

## Configuration

OpenAPI credentials and endpoints are intentionally not committed in skill files. They live in `.env.local` at the project root and are loaded by `datafinder.load_config_from_env()`. Ask the user for configuration when it is missing.

Required config usually includes:

- DataFinder environment: SaaS cloud-native, SaaS non-cloud-native, BytePlus overseas, or private deployment (`DATAFINDER_ENVIRONMENT`)
- base URL (`DATAFINDER_BASE_URL`) — see `manifest.json` `global.base_urls` for the per-environment value
- AK/SK (`DATAFINDER_ACCESS_KEY` / `DATAFINDER_SECRET_KEY`)
- nextop `app_id` (`DATAFINDER_APP_ID`) and `DATAFINDER_REGION`
- optional project/tenant headers for CDP/tag APIs (`DATAFINDER_PROJECT_ID`)

## Output Rules

Always include:

- data source and interface
- metric definition
- time range and timezone
- filters, especially `app_id`
- validation checks and result caveats

When API documentation details matter, link to the official 火山引擎 documentation rather than copying long API specs into the answer.
