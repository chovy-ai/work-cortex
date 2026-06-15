# QueryIntent Protocol

`QueryIntent` is the only output natural-language understanding may hand to routing/planning. It must be derived from `capabilities.json`; do not invent intents, capability IDs, templates, or slots.

## Inputs

- User natural language.
- `domains/intent-routing/capabilities.json`.
- Application defaults from `domains/metric-semantics/data-model-protocol.md`.
- User-provided OpenAPI/Kafka/local-file configuration when available.

## Output Status

Use exactly one status:

- `matched`: a registered CapabilitySpec can answer the request and all required slots are present or filled by approved defaults.
- `needs_clarification`: a registered CapabilitySpec can answer the request, but required slots are missing and no approved default exists.
- `unsupported`: no registered CapabilitySpec can answer the request directly.

## Required Shape

Matched or clarification output:

```json
{
  "status": "matched",
  "query_path": "raw_analysis",
  "original_text": "分析最近14天 DAU 增长，按版本拆一下",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_match": {
    "capability_id": "datafinder.openapi.analysis_query",
    "template_id": "analysis.dau_trend",
    "matched_required_slots": ["app_id", "metric", "time_range", "granularity"],
    "missing_required_slots": [],
    "fallback_capabilities": [
      "datafinder.openapi.analysis_download",
      "datafinder.kafka.behavior_event"
    ],
    "reason": "DAU trend is a computed aggregate metric supported by DataFinder analysis query."
  },
  "slots": {
    "app_id": "<your-app-id>",
    "metric": "dau",
    "time_range": "last_14_days",
    "timezone": "Asia/Shanghai",
    "granularity": "day",
    "identity": "device_id",
    "breakdowns": ["app_version"],
    "filters": []
  },
  "defaults_applied": [
    {
      "slot": "app_id",
      "value": "<your-app-id>",
      "source": "application defaults"
    }
  ],
  "warnings": []
}
```

Unsupported output:

```json
{
  "status": "unsupported",
  "original_text": "预测下个月 DAU",
  "reason": "No registered capability supports forecasting. Registered aggregate capabilities query historical computed data only.",
  "possible_fallbacks": ["datafinder.openapi.analysis_query"],
  "warnings": ["Can query historical DAU trend, but cannot forecast future DAU without an explicit forecasting capability."]
}
```

## Derivation Rules

1. Load all `CapabilitySpec` entries from `capabilities.json`.
2. Pick the first-level `category` from the four registered categories only.
3. Pick `intent` only from `capability.supported_intents`.
4. Pick `capability_id` only from the matched CapabilitySpec.
5. Pick `template_id` only from the matched CapabilitySpec's `templates`.
6. Extract slot keys only from the matched capability's `required_slots` and `optional_slots`.
7. Fill documented application defaults only when the default is semantically safe:
   - `app_id`: current application DataFinder app id from `domains/metric-semantics/data-model-protocol.md`.
   - `timezone`: `Asia/Shanghai` unless user specifies otherwise.
   - DAU identity: `device_id`.
   - DAU granularity: `day`.
8. If a required slot remains missing, return `needs_clarification` with `missing_required_slots` and a single concise `clarification_question`.
9. If the user request triggers a capability's `unsupported_when`, try its registered fallback capabilities. If none match, return `unsupported`.
10. **Set `query_path`** based on the matched category:
    - `dashboard`: category is `asset_reuse` (user references an existing dashboard, report, or provides a `report_id`/`dashboard_id`).
    - `raw_analysis`: category is `aggregate_analysis`, `user_level_query`, or `raw_diagnostics` — the model must decide event selection, metric definition, or calculation logic.

## Slot Semantics

Slots are capability-bound, not global free-form fields. Common slots:

| Slot | Meaning | Notes |
| --- | --- | --- |
| `app_id` | DataFinder app id | Default to the current application app id only for application analytics requests. |
| `metric` | Business metric | Examples: `dau`, `event_count`, `event_users`, `session_count`, `error_rate`. |
| `time_range` | User-requested period | Preserve relative ranges; planner later resolves them to absolute dates. |
| `timezone` | Date bucketing timezone | Default `Asia/Shanghai`. |
| `granularity` | Aggregation grain | `hour`, `day`, `week`, `month`. |
| `identity` | Distinct-user key | Default DAU identity is `device_id`. |
| `filters` | Where conditions | Each filter should include `field`, `op`, and `value`. |
| `breakdowns` | Group-by dimensions | Use DataFinder field names when known; otherwise mark for metadata lookup. |
| `event_set` | Events included in metric | For event usage/adoption. |
| `report_id` / `dashboard_id` | Existing DataFinder asset ids | Asset reuse category only. |
| `query_type` / `query_id` | User/device lookup | User-level query category only. |
| `metadata_type` | Metadata family | Raw diagnostics category only. |

## Clarification Rules

Ask only when a required slot cannot be inferred safely.

Examples:

- Missing `time_range` for metric trend: ask for time range.
- Missing `query_id` for user behavior flow: ask for user/device id.
- Missing `report_id` but dashboard name is provided: route to dashboard search/list instead of asking immediately.
- Missing OpenAPI credentials: keep QueryIntent matched, but execution must wait for configuration.

## Examples

### DAU Trend

Input: "分析最近 14 天日活增长"

```json
{
  "status": "matched",
  "query_path": "raw_analysis",
  "original_text": "分析最近 14 天日活增长",
  "category": "aggregate_analysis",
  "intent": "metric_trend",
  "capability_match": {
    "capability_id": "datafinder.openapi.analysis_query",
    "template_id": "analysis.dau_trend",
    "matched_required_slots": ["app_id", "metric", "time_range", "granularity"],
    "missing_required_slots": [],
    "fallback_capabilities": ["datafinder.openapi.analysis_download", "datafinder.kafka.behavior_event"],
    "reason": "DAU growth is an aggregate metric trend supported by DataFinder analysis."
  },
  "slots": {
    "app_id": "<your-app-id>",
    "metric": "dau",
    "time_range": "last_14_days",
    "timezone": "Asia/Shanghai",
    "granularity": "day",
    "identity": "device_id",
    "filters": [],
    "breakdowns": []
  },
  "defaults_applied": [
    {"slot": "app_id", "value": "<your-app-id>", "source": "application defaults"},
    {"slot": "timezone", "value": "Asia/Shanghai", "source": "skill default"},
    {"slot": "identity", "value": "device_id", "source": "application DAU policy"}
  ],
  "warnings": []
}
```

### Existing Report

Input: "查一下这个 report_id 的数据：abc123"

```json
{
  "status": "matched",
  "query_path": "dashboard",
  "original_text": "查一下这个 report_id 的数据：abc123",
  "category": "asset_reuse",
  "intent": "report_query",
  "capability_match": {
    "capability_id": "datafinder.openapi.report_query",
    "template_id": "report.query",
    "matched_required_slots": ["app_id", "report_id"],
    "missing_required_slots": [],
    "fallback_capabilities": ["datafinder.openapi.dashboard_reports"],
    "reason": "The request references an existing DataFinder report asset."
  },
  "slots": {
    "app_id": "<your-app-id>",
    "report_id": "abc123"
  },
  "defaults_applied": [
    {"slot": "app_id", "value": "<your-app-id>", "source": "application defaults"}
  ],
  "warnings": []
}
```

### User Flow Needs Clarification

Input: "看一下这个用户最近做了什么"

```json
{
  "status": "needs_clarification",
  "query_path": "raw_analysis",
  "original_text": "看一下这个用户最近做了什么",
  "category": "user_level_query",
  "intent": "user_flow",
  "capability_match": {
    "capability_id": "datafinder.openapi.behavior_flow",
    "template_id": "user.behavior_flow",
    "matched_required_slots": ["app_id"],
    "missing_required_slots": ["query_type", "query_id", "timestamp", "orientation", "count"],
    "fallback_capabilities": ["datafinder.kafka.behavior_event"],
    "reason": "Behavior flow requires a concrete user/device identifier and anchor timestamp."
  },
  "slots": {
    "app_id": "<your-app-id>"
  },
  "defaults_applied": [
    {"slot": "app_id", "value": "<your-app-id>", "source": "application defaults"}
  ],
  "clarification_question": "请提供要查询的 user_unique_id、device_id、ssid 或 web_id，以及希望围绕哪个时间点查看行为流。",
  "warnings": []
}
```
