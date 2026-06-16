# ExecutionResult Protocol — Dashboard Path

Applies to `query_path: dashboard` only. Captures the outcome of calling
the DataFinder report/dashboard API.

Records only result or error. Do not include timing or performance fields.

## Output Status

- `success`: API call returned data.
- `error`: call failed or returned a business error.

## Success Shape

```json
{
  "status": "success",
  "compiled_id": "report.query.openapi",
  "execution_kind": "openapi",
  "result": {
    "kind": "report_data",
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
  "compiled_id": "report.query.openapi",
  "execution_kind": "openapi",
  "error": {
    "code": "openapi_auth_failed",
    "message": "DataFinder OpenAPI authentication failed.",
    "retryable": false,
    "details": { "http_status": 401 }
  },
  "warnings": []
}
```

## Result Kind

Dashboard path always produces `report_data` (columns + rows from the asset).
If the API succeeds but returns no rows, use `kind: empty`.

## Error Codes

| Code | Meaning |
|------|---------|
| `openapi_auth_failed` | Auth rejected. |
| `openapi_http_error` | Non-success HTTP status. |
| `openapi_business_error` | HTTP 200 but business error payload. |
| `unknown_error` | Unexpected failure. |

## Normalization Rules

1. Preserve `compiled_id` from `CompiledQuery`.
2. Convert report response into `result.kind = report_data` (columns + rows).
3. If no rows returned but request succeeded, use `result.kind = empty`.
4. Redact auth credentials from `raw`.
5. Do not interpret result content here; explanation belongs to Step 8A output.
