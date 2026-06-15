# CompiledQuery Protocol

`CompiledQuery` is the fourth-layer protocol. It converts a `QueryPlan` into an executable request plan for one of three runtime families:

- DataFinder OpenAPI request
- Kafka/raw event sampling plan
- local file query plan

This layer is allowed to contain API paths, HTTP method, request body, Kafka topic/group config, or SQL text. It does not execute the query and does not interpret results.

## Inputs

- A `QueryPlan` with `status = ready`.
- Environment configuration:
  - OpenAPI: `base_url`, auth config, environment, optional headers.
  - Kafka: broker/zookeeper, topic, consumer group, offset policy.
  - Local file: file path and parser format.
- Official DataFinder docs from `domains/datafinder-interface/openapi-routing.md`.

Do not compile a blocked QueryPlan. Return a blocked compiled query only if config becomes unavailable during compilation.

## Output Status

Use exactly one status:

- `ready`: executable request/command/query is complete.
- `blocked`: compilation cannot safely produce an executable artifact.

## Top-Level Shape

```json
{
  "status": "ready",
  "compiled_id": "analysis.dau_trend.openapi",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "execution_kind": "openapi",
  "openapi": {
    "method": "POST",
    "base_url": "https://analytics.volcengineapi.com",
    "path": "/datafinder/openapi/v1/analysis",
    "headers": {
      "Content-Type": "application/json"
    },
    "auth": {
      "type": "volcengine_ak_sk",
      "configured": true
    },
    "body": {
      "app_id": 20004134,
      "template": "analysis.dau_trend"
    }
  },
  "preflight": [
    "check_openapi_config",
    "check_auth_config",
    "check_app_id"
  ],
  "postflight": [
    "check_http_success",
    "check_empty_result",
    "check_date_coverage"
  ],
  "redactions": ["auth"],
  "docs": [
    "https://www.volcengine.com/docs/84129/1285238?lang=zh"
  ],
  "warnings": []
}
```

## Compilation Rules

1. Compile only registered templates from `capabilities.json`.
2. Preserve `plan_id`, `capability_id`, and `template_id`.
3. Pick `execution_kind` from:
   - `openapi`
   - `kafka`
   - `local_sql`
   - `local_file_parse`
4. If `source = datafinder_openapi`, produce an `openapi` object.
5. If `source = datafinder_kafka`, produce a `kafka` object.
6. If `source = local_file`, produce `local_sql` or `local_file` object depending on the template.
7. Never embed raw AK/SK or secrets in committed files or final explanations. Represent auth as configured metadata and redact secrets.
8. Include official documentation links for every OpenAPI capability.
9. Include `preflight` and `postflight` checks so execution and result validation are deterministic.
10. If the DataFinder API body details are not yet implemented, compile a placeholder body with `template` and `compiler_inputs`, and mark `warnings` with `compiler_body_pending`.

## OpenAPI Mapping

Use these path families until exact endpoint wrappers are implemented from official docs/config:

| Template family | Capability | OpenAPI docs | Body policy |
| --- | --- | --- | --- |
| `analysis.*` | `datafinder.openapi.analysis_query` | https://www.volcengine.com/docs/84129/1285238?lang=zh | analysis DSL body |
| `analysis.result_fetch` | `datafinder.openapi.analysis_result` | https://www.volcengine.com/docs/84129/1285232 | result id body/query |
| `analysis.download` | `datafinder.openapi.analysis_download` | https://www.volcengine.com/docs/84129/1285237 | export/download body |
| `dashboard.*`, `report.*` | dashboard/report capabilities | https://www.volcengine.com/docs/84129/1285218?lang=zh | dashboard/report id body |
| `user.*` | user analysis capabilities | https://www.volcengine.com/docs/84129/1285278?lang=zh | user query body |
| `segment.*` | segment capabilities | https://www.volcengine.com/docs/84129?lang=zh | segment id/query body |
| `tag.query` | tag capabilities | https://www.volcengine.com/docs/84129/1285256?lang=zh | tag version-specific body |
| `raw_event.*` | raw event export | https://www.volcengine.com/docs/84129?lang=zh | export task/list body |
| `metadata.*` | metadata query | https://www.volcengine.com/docs/84129?lang=zh | metadata type body |
| `governance.*` | data governance | https://www.volcengine.com/docs/84129?lang=zh | ingestion validation body |

Use precise URLs from `domains/datafinder-interface/openapi-routing.md` when available.

## Runtime Shapes

### OpenAPI

```json
{
  "execution_kind": "openapi",
  "openapi": {
    "method": "POST",
    "base_url": "https://analytics.volcengineapi.com",
    "path": "/datafinder/openapi/v1/analysis",
    "headers": {
      "Content-Type": "application/json"
    },
    "auth": {
      "type": "volcengine_ak_sk",
      "configured": true
    },
    "body": {}
  }
}
```

### Kafka

```json
{
  "execution_kind": "kafka",
  "kafka": {
    "topic": "behavior_event",
    "consumer_group": "app-analysis-adhoc",
    "connection_ref": "provided_by_user",
    "offset_policy": "latest",
    "sample_limit": 1000,
    "filters": [
      {"field": "header.app_id", "op": "eq", "value": 20004134}
    ]
  }
}
```

### Local SQL

```json
{
  "execution_kind": "local_sql",
  "local_sql": {
    "engine": "duckdb",
    "input_files": ["./events.ndjson"],
    "sql": "select date_trunc('day', event_time) as day, count(distinct device_id) as dau from events group by 1 order by 1"
  }
}
```

## Blocked Example

```json
{
  "status": "blocked",
  "compiled_id": "analysis.dau_trend.openapi",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "execution_kind": "openapi",
  "blocked_reason": "missing_config",
  "required_to_unblock": ["base_url", "auth_config"],
  "warnings": ["OpenAPI config has not been provided yet."]
}
```

## Ready DAU Example

The exact DataFinder analysis DSL body should be finalized after OpenAPI config and endpoint examples are available. Until then, keep the body explicit but marked pending:

```json
{
  "status": "ready",
  "compiled_id": "analysis.dau_trend.openapi",
  "plan_id": "analysis.dau_trend",
  "source": "datafinder_openapi",
  "capability_id": "datafinder.openapi.analysis_query",
  "template_id": "analysis.dau_trend",
  "execution_kind": "openapi",
  "openapi": {
    "method": "POST",
    "base_url": "https://analytics.volcengineapi.com",
    "path": "/datafinder/openapi/v1/analysis",
    "headers": {
      "Content-Type": "application/json"
    },
    "auth": {
      "type": "volcengine_ak_sk",
      "configured": true
    },
    "body": {
      "app_id": 20004134,
      "template": "analysis.dau_trend",
      "metric_definition": {
        "metric": "dau",
        "aggregation": "count_distinct",
        "field": "device_id"
      },
      "time": {
        "start": "2026-05-26",
        "end": "2026-06-08",
        "timezone": "Asia/Shanghai",
        "granularity": "day"
      },
      "filters": [],
      "breakdowns": []
    }
  },
  "preflight": [
    "check_openapi_config",
    "check_auth_config",
    "check_app_id"
  ],
  "postflight": [
    "check_http_success",
    "check_empty_result",
    "check_date_coverage",
    "check_identity_null_rate"
  ],
  "redactions": ["auth"],
  "docs": [
    "https://www.volcengine.com/docs/84129/1285238?lang=zh"
  ],
  "warnings": ["compiler_body_pending"]
}
```
