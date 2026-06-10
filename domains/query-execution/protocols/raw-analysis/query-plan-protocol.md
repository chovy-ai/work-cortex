# QueryPlan Protocol

`QueryPlan` is the third-layer protocol: it converts a matched `QueryIntent` into a deterministic, compiler-ready plan. It still does not contain final OpenAPI request bodies, Kafka commands, or SQL strings; those belong to the compiler/executor layer.

## Inputs

- A `QueryIntent` with `status = matched`.
- The matched `CapabilitySpec` from `domains/intent-routing/capabilities.json`.
- nextop defaults from `domains/metric-semantics/data-model-protocol.md`.
- OpenAPI/Kafka/local-file configuration availability flags.
- Current date/time for resolving relative time ranges.

Do not build a `QueryPlan` for `needs_clarification` or `unsupported` intents.

## Output Status

Use exactly one status:

- `ready`: all compiler-required fields are resolved.
- `blocked`: the intent is matched, but the plan cannot be compiled because configuration, metadata, or required deterministic resolution is missing.

## Required Shape

```json
{
  "status": "ready",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "compiler": "datafinder.analysis",
  "app": {
    "app_id": 20004134,
    "timezone": "Asia/Shanghai"
  },
  "time": {
    "input": "last_14_days",
    "resolved": {
      "start": "2026-05-26",
      "end": "2026-06-08",
      "timezone": "Asia/Shanghai",
      "granularity": "day"
    }
  },
  "metric_definition": {
    "metric": "dau",
    "aggregation": "count_distinct",
    "field": "device_id",
    "event_set": []
  },
  "dimensions": {
    "breakdowns": ["app_version"],
    "filters": []
  },
  "compiler_inputs": {
    "analysis_template": "analysis.dau_trend"
  },
  "validation": [
    "check_app_id",
    "check_date_coverage",
    "check_empty_result",
    "check_identity_null_rate"
  ],
  "warnings": []
}
```

## Derivation Rules

1. Copy `category`, `intent`, `capability_id`, and `template_id` from `QueryIntent.capability_match`.
2. Look up the matched CapabilitySpec from `capabilities.json`.
3. Set `source` from the capability id:
   - `datafinder.openapi.*` -> `datafinder_openapi`
   - `datafinder.kafka.*` -> `datafinder_kafka`
   - `datafinder.local.*` -> `local_file`
4. Set `compiler` from template family:
   - `analysis.*` -> `datafinder.analysis`
   - `dashboard.*` or `report.*` -> `datafinder.asset`
   - `user.*`, `segment.*`, `tag.*` -> `datafinder.user`
   - `raw_event.*`, `metadata.*`, `governance.*`, `usage.*`, `openapi.*` -> `datafinder.diagnostics`
   - `kafka.*` -> `datafinder.kafka`
   - `local.*` -> `local.file`
5. Resolve relative time ranges into absolute dates before `status = ready`.
6. Convert business metrics into metric definitions:
   - `dau` -> `count_distinct(device_id)`
   - `wau` -> `count_distinct(device_id)` with week granularity
   - `mau` -> `count_distinct(device_id)` with month granularity
   - `event_count` -> `count(*)`
   - `event_users` -> `count_distinct(identity)`
   - `session_count` -> `count_distinct(session_id)`
7. Preserve field names when user gives DataFinder/nextop field names. If a requested field is ambiguous, block with a required metadata lookup.
8. Add validation checks based on output type:
   - aggregate tables: app id, date coverage, empty result, identity null rate.
   - report data: report id and row limit.
   - user-level data: identifier type/value and empty result.
   - raw diagnostics: sample size, offset/range, schema parseability.
9. If OpenAPI/Kafka configuration is missing, `QueryPlan.status` may still be `blocked` with `blocked_reason = "missing_config"`; do not fabricate request details.

## Source-Specific Plan Fields

### Aggregate Analysis

Required compiler inputs:

- `analysis_template`
- `metric_definition`
- `time.resolved`
- `dimensions.filters`
- `dimensions.breakdowns`

Use this for `analysis.dau_trend`, `analysis.metric_trend`, `analysis.metric_breakdown`, and `analysis.event_usage`.

### Asset Reuse

Required compiler inputs vary by template:

- `dashboard.list`: `app_id`, optional keyword/owner.
- `dashboard.reports`: `app_id`, `dashboard_id`.
- `report.query`: `app_id`, `report_id`, optional period/count/filters.

Do not convert report queries into analysis DSL unless the user asks to recreate the report from its DSL.

### User-Level Query

Required compiler inputs:

- `user.profile`: `app_id`, `query_type`, `query_id`.
- `user.behavior_flow`: `app_id`, `query_type`, `query_id`, `timestamp`, `orientation`, `count`.
- `segment.*`: segment id or app id depending on template.
- `tag.query`: tag id/name and version-specific tenant/project/app slots.

### Raw Diagnostics

Required compiler inputs:

- Kafka sample: `broker_or_zk`, `topic`, `consumer_group`, `app_id`.
- Raw export: `app_id`, `export_type`.
- Metadata: `app_id`, `metadata_type`.
- Ingestion validation: `app_id`, `time_range`.

## Blocked Plan Example

```json
{
  "status": "blocked",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "compiler": "datafinder.analysis",
  "blocked_reason": "missing_config",
  "required_to_unblock": ["base_url", "auth_config"],
  "warnings": ["OpenAPI credentials are not stored in the skill and must be provided separately."]
}
```

## Ready Plan Examples

### DAU Trend

Input QueryIntent slots:

```json
{
  "app_id": 20004134,
  "metric": "dau",
  "time_range": "last_14_days",
  "timezone": "Asia/Shanghai",
  "granularity": "day",
  "identity": "device_id",
  "filters": [],
  "breakdowns": []
}
```

Output QueryPlan:

```json
{
  "status": "ready",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "compiler": "datafinder.analysis",
  "app": {
    "app_id": 20004134,
    "timezone": "Asia/Shanghai"
  },
  "time": {
    "input": "last_14_days",
    "resolved": {
      "start": "2026-05-26",
      "end": "2026-06-08",
      "timezone": "Asia/Shanghai",
      "granularity": "day"
    }
  },
  "metric_definition": {
    "metric": "dau",
    "aggregation": "count_distinct",
    "field": "device_id",
    "event_set": []
  },
  "dimensions": {
    "breakdowns": [],
    "filters": []
  },
  "compiler_inputs": {
    "analysis_template": "analysis.dau_trend"
  },
  "validation": [
    "check_app_id",
    "check_date_coverage",
    "check_empty_result",
    "check_identity_null_rate"
  ],
  "warnings": []
}
```

### Report Query

```json
{
  "status": "ready",
  "plan_id": "report.query",
  "source": "datafinder_openapi",
  "category": "asset_reuse",
  "intent": "report_query",
  "capability_id": "datafinder.openapi.report_query",
  "template_id": "report.query",
  "compiler": "datafinder.asset",
  "app": {
    "app_id": 20004134
  },
  "asset": {
    "report_id": "abc123"
  },
  "compiler_inputs": {
    "report_id": "abc123",
    "count": 1000
  },
  "validation": [
    "check_report_id",
    "check_row_limit",
    "check_empty_result"
  ],
  "warnings": []
}
```
