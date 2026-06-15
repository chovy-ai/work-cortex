# Application Analytics Data Model

> 这是通用口径协议模板。具体应用的真实路径/取值由 `app.config.json` 指定，并由
> `extract_data_model` 抽取进 `knowledge-store/data-model.json`；下文 `<app-repo>` /
> `<your-app-id>` 等为占位符。

## Repository Sources

（均相对应用 repo 根，实际路径见 `app.config.json` 的 `sources`）

- Architecture: `<app-repo>/path/to/analytics-tracking.md`
- DataFinder defaults: `<app-repo>/config/app.defaults.json`
- Reporter service implementation: `<app-repo>/path/to/reporter/tea_reporter.go`
- Renderer analytics reporters: `<app-repo>/path/to/analytics/reporters`

## Current App Defaults

应用的埋点默认值文件（`app.config.json` → `sources.dataModel.defaults`）通常定义：

- DataFinder `appId`: `<your-app-id>`
- `appName`: `<your-app-name>`
- channel domain: `<your-channel-domain>`
- analytics app version default: `0.0.0`

Always re-read the defaults file before making a real query because these values may change.

## Reporting Flow

Renderer events:

```text
renderer reporter
-> IReporterService.trackEvents()
-> daemon client.trackEvents()
-> POST /v1/track
-> reporter service Track()
-> TeaReporter / DataFinder SDK
-> DataFinder backend
```

Daemon events:

```text
daemon workflow
-> Reporter.Track()
-> TeaReporter / DataFinder SDK
```

## Authoritative Common Params

`TeaReporter` injects these common params:

- `device_id`: stable UUID persisted in the app's state dir
- `session_id`: UUID generated once per reporter-service startup
- `app_version`: resolved from app defaults/env
- `os`: Go runtime OS name

`TeaReporter` removes renderer-supplied `device_id`, `session_id`, `app_version`, and `os` from event params before sending. Treat reporter-service-owned values as authoritative.

## Event Names

Event names follow dot-separated product domains, for example:

- `app.session_start`
- `workspace.opened`
- `agent.session_started`
- `app_center.app_opened`
- `issue_manager.task_run_initiated`
- `error.agent_session_failed`

Before doing event-specific analysis, inspect:

- `<app-repo>/path/to/analytics/reporters/reporterCompleteness.test.ts`
- reporter directories under `<app-repo>/path/to/analytics/reporters`

## Default Analysis Definitions

DAU:

```text
count(distinct device_id)
where app_id = the application's DataFinder appId
group by local day
```

Session count:

```text
count(distinct session_id)
group by local day
```

Event usage:

```text
count(*), count(distinct device_id)
group by event_name and local day
```

Feature adoption:

```text
count(distinct device_id)
where event_name in feature event set
group by local day
```

Error rate:

```text
error event users / relevant feature event users
```

Define the denominator explicitly; do not mix all-app DAU with feature-specific errors unless the user asks for app-wide impact.

## Validation Checklist

- Confirm `app_id` matches current app defaults.
- Confirm timezone, usually `Asia/Shanghai` unless the user requests another.
- Compare event occurrence time with server ingestion time if the trend has sharp edges.
- Count rows with missing `device_id`.
- Check whether the event set includes startup/error/background-only events.
- For OpenAPI results, note whether the data is cached or downloaded from an export task.
