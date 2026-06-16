# ExecutionResult Protocol

`ExecutionResult` is the fifth-layer protocol. It captures the outcome of executing a `CompiledQuery`.

It intentionally records only result or error. Do not include duration, latency, timing, or performance fields.

## Inputs

- A `CompiledQuery` with `status = ready`.
- Runtime configuration needed by the compiled query.

Do not execute a blocked compiled query.

## Output Status

Use exactly one status:

- `success`: execution produced a result payload.
- `error`: execution failed or returned an API/runtime error.

## Success Shape

```json
{
  "status": "success",
  "compiled_id": "analysis.dau_trend.openapi",
  "execution_kind": "openapi",
  "result": {
    "kind": "table",
    "columns": ["date", "dau"],
    "rows": [
      ["2026-05-26", 120],
      ["2026-05-27", 138]
    ],
    "row_count": 2
  },
  "raw": {
    "kind": "openapi_response",
    "http_status": 200,
    "body_ref": "redacted_or_attached_runtime_response"
  },
  "warnings": []
}
```

## Error Shape

```json
{
  "status": "error",
  "compiled_id": "analysis.dau_trend.openapi",
  "execution_kind": "openapi",
  "error": {
    "code": "openapi_auth_failed",
    "message": "DataFinder OpenAPI authentication failed.",
    "retryable": false,
    "details": {
      "http_status": 401
    }
  },
  "warnings": []
}
```

## Result Kinds

Use one of:

- `table`: columns and rows.
- `records`: array of structured objects.
- `file`: file path or download reference.
- `scalar`: one numeric/string/boolean value.
- `raw_events`: sampled raw Kafka/export events.
- `empty`: successful execution with no data.

## Error Codes

Use stable, machine-readable codes:

| Code | Meaning |
| --- | --- |
| `openapi_auth_failed` | OpenAPI auth rejected the request. |
| `openapi_http_error` | OpenAPI returned non-success HTTP status. |
| `openapi_business_error` | OpenAPI returned success transport but business error payload. |
| `kafka_connection_failed` | Kafka connection failed. |
| `kafka_consume_failed` | Kafka read failed after connection. |
| `local_file_not_found` | Input file does not exist. |
| `local_parse_failed` | Local file parsing failed. |
| `local_query_failed` | Local SQL/query execution failed. |
| `schema_mismatch` | Returned data does not match expected result shape. |
| `unknown_error` | Unexpected error. |

## Normalization Rules

1. Preserve `compiled_id` and `execution_kind` from `CompiledQuery`.
2. Convert successful OpenAPI table-like responses into `result.kind = table` when possible.
3. Convert user/profile/metadata responses into `records`.
4. Convert downloads/exports into `file`.
5. Convert Kafka samples into `raw_events`.
6. If no rows are returned but the request succeeded, use `result.kind = empty` rather than `error`.
7. Redact secrets and credentials from `raw`.
8. Keep raw response by reference (`body_ref`) when the payload is large or sensitive.
9. Do not summarize or interpret the result here; result explanation belongs to the final analysis layer.

## Examples

### Empty Success

```json
{
  "status": "success",
  "compiled_id": "analysis.dau_trend.openapi",
  "execution_kind": "openapi",
  "result": {
    "kind": "empty",
    "row_count": 0
  },
  "raw": {
    "kind": "openapi_response",
    "http_status": 200,
    "body_ref": "redacted_or_attached_runtime_response"
  },
  "warnings": ["empty_result"]
}
```

### Kafka Raw Events

```json
{
  "status": "success",
  "compiled_id": "kafka.behavior_event_sample",
  "execution_kind": "kafka",
  "result": {
    "kind": "raw_events",
    "records": [
      {
        "event_name": "workspace.opened",
        "header": {
          "app_id": 20004134
        }
      }
    ],
    "row_count": 1
  },
  "raw": {
    "kind": "kafka_records",
    "body_ref": "redacted_or_attached_runtime_records"
  },
  "warnings": []
}
```
