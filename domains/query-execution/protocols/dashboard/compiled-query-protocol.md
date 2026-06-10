# CompiledQuery Protocol — Dashboard Path

Applies to `query_path: dashboard` only. Converts a dashboard `QueryPlan`
into an executable DataFinder report/dashboard API request.

The request body carries only `asset_id` and the resolved time range.
Do not include metric DSL, event filters, or breakdown logic — those are
owned by the DataFinder asset.

## Inputs

- A dashboard `QueryPlan` with `status = ready`.
- OpenAPI environment config: `base_url`, `auth_config`.

## Output Status

- `ready`: executable request is complete.
- `blocked`: config became unavailable during compilation.

## Required Shape

```json
{
  "status": "ready",
  "compiled_id": "report.query.openapi",
  "plan_id": "report.query",
  "source": "datafinder_openapi",
  "capability_id": "datafinder.openapi.report_query",
  "template_id": "report.query",
  "execution_kind": "openapi",
  "openapi": {
    "method": "POST",
    "base_url": "https://analytics.volcengineapi.com",
    "path": "/datafinder/openapi/v1/report/query",
    "headers": {
      "Content-Type": "application/json"
    },
    "auth": {
      "type": "volcengine_ak_sk",
      "configured": true
    },
    "body": {
      "app_id": 20004134,
      "report_id": "abc123",
      "count": 1000,
      "period": {
        "start_time": "2026-05-26",
        "end_time": "2026-06-08"
      }
    }
  },
  "preflight": [
    "check_openapi_config",
    "check_auth_config",
    "check_report_id"
  ],
  "postflight": [
    "check_http_success",
    "check_empty_result",
    "check_row_limit"
  ],
  "redactions": ["auth"],
  "docs": [
    "https://www.volcengine.com/docs/84129/1285240?lang=zh"
  ],
  "warnings": []
}
```

## Compilation Rules

1. `execution_kind` is always `openapi` for the dashboard path.
2. Body contains only: `app_id`, `report_id` (or `dashboard_id`), `count`, `period`.
3. `period.start_time` and `period.end_time` come from `QueryPlan.time.resolved`.
4. Never add metric DSL, filters, or breakdowns to the body.
5. Never embed raw AK/SK; represent auth as configured metadata only.
6. If `dashboard_id` is present but `report_id` is not, use the dashboard list path
   (`/datafinder/openapi/v1/dashboard/reports`) to enumerate report ids first.

## Docs

- Dashboard/report API: https://www.volcengine.com/docs/84129/1285218
- Report query API:     https://www.volcengine.com/docs/84129/1285240?lang=zh
