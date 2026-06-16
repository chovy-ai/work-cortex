# QueryPlan Protocol — Dashboard Path

Applies to `query_path: dashboard` only. The metric definition and calculation
logic are owned by the DataFinder asset; this plan only resolves the time range
and validates that the required asset identifier is present.

Do not expand metric definitions, apply event selection logic, or route to
Kafka/local-file sources here. Those belong to the raw_analysis path.

## Inputs

- A `QueryIntent` with `status = matched` and `query_path = dashboard`.
- Current date/time for resolving relative time ranges.
- OpenAPI configuration availability flag.

## Output Status

- `ready`: `asset_id` and `time.resolved` are both present.
- `blocked`: OpenAPI config is missing or `asset_id` could not be resolved.

## Required Shape

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
  "time": {
    "input": "last_14_days",
    "resolved": {
      "start": "2026-05-26",
      "end": "2026-06-08"
    }
  },
  "validation": [
    "check_report_id",
    "check_row_limit",
    "check_empty_result"
  ],
  "warnings": []
}
```

## Derivation Rules

1. Copy `category`, `intent`, `capability_id`, and `template_id` from `QueryIntent.capability_match`.
2. Set `source = datafinder_openapi` and `compiler = datafinder.asset`.
3. Set `asset` from `QueryIntent.slots`:
   - Use `report_id` when available.
   - Use `dashboard_id` when only dashboard-level id is known; the executor will
     call `list_dashboard_reports()` to resolve individual report ids.
4. Resolve relative time range to absolute `start` / `end` dates using current date.
   No granularity or timezone expansion is required; the asset owns those settings.
5. If OpenAPI config is missing, return `blocked` with `blocked_reason = "missing_config"`.
6. If neither `report_id` nor `dashboard_id` is available, return `blocked` with
   `blocked_reason = "missing_asset_id"`.

## Blocked Example

```json
{
  "status": "blocked",
  "plan_id": "report.query",
  "source": "datafinder_openapi",
  "compiler": "datafinder.asset",
  "blocked_reason": "missing_config",
  "required_to_unblock": ["base_url", "auth_config"],
  "warnings": ["OpenAPI credentials have not been provided."]
}
```
