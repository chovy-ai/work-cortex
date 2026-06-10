# nextop Analytics Data Model

## Repository Sources

- Architecture: `/Users/zhengweibin/Desktop/team-shell/nextop/docs/architecture/analytics-tracking.md`
- DataFinder defaults: `/Users/zhengweibin/Desktop/team-shell/nextop/config/nextop.defaults.json`
- nextopd reporter implementation: `/Users/zhengweibin/Desktop/team-shell/nextop/services/nextopd/service/reporter/tea_reporter.go`
- Renderer analytics reporters: `/Users/zhengweibin/Desktop/team-shell/nextop/apps/desktop/src/renderer/src/features/analytics/reporters`

## Current App Defaults

As of this skill creation, `nextop/config/nextop.defaults.json` defines:

- DataFinder `appId`: `20004134`
- `appName`: `tutti`
- channel domain: `https://gator.uba.ap-southeast-1.volces.com`
- analytics app version default: `0.0.0`

Always re-read the defaults file before making a real query because these values may change.

## Reporting Flow

Renderer events:

```text
renderer reporter
-> IReporterService.trackEvents()
-> NextopdClient.trackEvents()
-> POST /v1/track
-> nextopd Reporter.Track()
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

- `device_id`: stable UUID persisted in nextop state dir
- `session_id`: UUID generated once per nextopd startup
- `app_version`: resolved from nextop defaults/env
- `os`: Go runtime OS name

`TeaReporter` removes renderer-supplied `device_id`, `session_id`, `app_version`, and `os` from event params before sending. Treat nextopd-owned values as authoritative.

## Event Names

Event names follow dot-separated product domains, for example:

- `app.session_start`
- `workspace.opened`
- `agent.session_started`
- `app_center.app_opened`
- `issue_manager.task_run_initiated`
- `error.agent_session_failed`

Before doing event-specific analysis, inspect:

- `/Users/zhengweibin/Desktop/team-shell/nextop/apps/desktop/src/renderer/src/features/analytics/reporters/reporterCompleteness.test.ts`
- reporter directories under `/Users/zhengweibin/Desktop/team-shell/nextop/apps/desktop/src/renderer/src/features/analytics/reporters`

## Default Analysis Definitions

DAU:

```text
count(distinct device_id)
where app_id = nextop DataFinder appId
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

- Confirm `app_id` matches current nextop defaults.
- Confirm timezone, usually `Asia/Shanghai` unless the user requests another.
- Compare event occurrence time with server ingestion time if the trend has sharp edges.
- Count rows with missing `device_id`.
- Check whether the event set includes startup/error/background-only events.
- For OpenAPI results, note whether the data is cached or downloaded from an export task.
