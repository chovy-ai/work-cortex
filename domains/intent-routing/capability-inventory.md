# Capability Inventory

This file defines how to reason from DataFinder's bottom-level callable capabilities to the protocol between natural-language understanding and query compilation.

Machine-readable source: `domains/intent-routing/capabilities.json`.

Do not invent categories, intents, or slots outside the registered CapabilitySpec set unless the user explicitly asks to extend the skill.

## CapabilitySpec Shape

Each capability must be represented as:

```json
{
  "category": "aggregate_analysis",
  "capability_id": "datafinder.openapi.analysis_query",
  "status": "available_after_config",
  "datafinder_area": "查询分析",
  "supported_intents": ["metric_trend"],
  "templates": ["analysis.metric_trend"],
  "required_slots": ["app_id", "metric", "time_range", "granularity"],
  "optional_slots": ["identity", "filters"],
  "constraints": {
    "requires_openapi_config": true,
    "supports_raw_events": false,
    "supports_large_export": false
  },
  "output": "aggregate_table",
  "fallback_capabilities": ["datafinder.kafka.behavior_event"],
  "unsupported_when": ["request requires raw event payload fields"]
}
```

## Status Values

- `available_after_config`: callable after the user provides OpenAPI or Kafka configuration.
- `local_only`: callable against local files or copied data without remote credentials.
- `planned`: not implemented yet; do not claim it can run.

## Category Overview

| Category ID | DataFinder area | Primary purpose | Supported request family |
| --- | --- | --- | --- |
| `aggregate_analysis` | 查询分析 | Compute aggregate metrics, trends, breakdowns, and analysis results. | DAU growth, active users by version, event usage, trend changes |
| `asset_reuse` | 看板与报表 | Reuse existing DataFinder dashboards and report definitions. | query dashboards/reports already built in DataFinder |
| `user_level_query` | 用户分析、分群、用户标签 | Query one user/device, user lists, segments, and tags. | user profile, behavior flow, segment export, tag filter |
| `raw_diagnostics` | 原始事件导出、用户属性导出、数据治理/Kafka、元数据 | Inspect raw data, metadata, ingestion quality, and custom extracts. | event debugging, field confirmation, custom calculation |

## Protocol Direction

The protocol must be derived from CapabilitySpec:

1. Load `capabilities.json`.
2. Match user language only to registered `category` and `supported_intents`.
3. Extract only slots listed in the chosen capability's required or optional slots.
4. If required slots are missing, ask for them or apply documented nextop defaults.
5. If no capability supports the request, return `unsupported` with registered fallback capabilities.
6. Compile only through a registered template.

## Category Summaries

### Aggregate Analysis

Use when the user asks for computed metrics rather than raw rows.

Registered capability families:

- `datafinder.openapi.analysis_query`
- `datafinder.openapi.analysis_result`
- `datafinder.openapi.analysis_download`
- `datafinder.local.csv_query`
- `datafinder.local.ndjson_query`

Common templates:

- `analysis.dau_trend`
- `analysis.metric_trend`
- `analysis.metric_breakdown`
- `analysis.event_usage`
- `analysis.download`
- `local.file_metric_query`

### Asset Reuse

Use when the user references DataFinder dashboards, reports, saved charts, or wants parity with the UI.

Registered capability families:

- `datafinder.openapi.dashboard_list`
- `datafinder.openapi.dashboard_reports`
- `datafinder.openapi.report_query`

Common templates:

- `dashboard.list`
- `dashboard.reports`
- `report.query`

### User-Level Query

Use when the output is about one user/device, a list of users, a segment, or tags.

Registered capability families:

- `datafinder.openapi.user_profile`
- `datafinder.openapi.behavior_flow`
- `datafinder.openapi.user_query_create`
- `datafinder.openapi.user_query_result`
- `datafinder.openapi.segment_query`
- `datafinder.openapi.tag_v1`
- `datafinder.openapi.tag_v2`

Common templates:

- `user.profile`
- `user.behavior_flow`
- `user.query_create`
- `user.query_result`
- `segment.list`
- `segment.users`
- `segment.download`
- `tag.query`

### Raw Diagnostics

Use when the user needs raw events, metadata, data quality signals, or custom logic outside DataFinder aggregation.

Registered capability families:

- `datafinder.kafka.behavior_event`
- `datafinder.kafka.user_profile`
- `datafinder.openapi.raw_event_export`
- `datafinder.openapi.user_property_export`
- `datafinder.openapi.metadata_query`
- `datafinder.openapi.ingestion_validation`
- `datafinder.openapi.usage_stats`
- `datafinder.openapi.calling_context`

Common templates:

- `kafka.behavior_event_sample`
- `raw_event.file_list`
- `raw_event.custom_export`
- `metadata.events`
- `metadata.event_properties`
- `governance.ingestion_detail`
- `usage.day`

## Routing Order

Route in this order:

1. If the user provides a local file, use local capabilities under `aggregate_analysis`.
2. If the user names an existing dashboard/report or provides `report_id`/`dashboard_id`, use `asset_reuse`.
3. If the user asks for aggregate metric trends, breakdowns, or event usage, use `aggregate_analysis`.
4. If the user asks about one user/device, a segment, tag, or user export, use `user_level_query`.
5. If the user asks about ingestion correctness, raw fields, metadata, real-time monitoring, or custom logic DataFinder analysis cannot express, use `raw_diagnostics`.

## Intent Output Constraint

The natural-language layer should emit a `QueryIntent` only after matching a CapabilitySpec:

```json
{
  "status": "matched",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_match": {
    "capability_id": "datafinder.openapi.analysis_query",
    "template_id": "analysis.dau_trend",
    "matched_required_slots": ["app_id", "metric", "time_range", "granularity"],
    "missing_required_slots": []
  },
  "slots": {
    "metric": "dau",
    "time_range": "last_14_days",
    "granularity": "day"
  }
}
```

If no registered capability can answer:

```json
{
  "status": "unsupported",
  "reason": "No registered capability can answer this request directly.",
  "possible_fallbacks": ["datafinder.kafka.behavior_event"]
}
```
