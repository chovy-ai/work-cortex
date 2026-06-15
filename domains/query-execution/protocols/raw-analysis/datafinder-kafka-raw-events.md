# DataFinder Kafka Raw Events

Official reference: https://www.volcengine.com/docs/84129/1261811?lang=zh

Use this reference when OpenAPI is not the right source and the analysis needs raw DataFinder events.

## Topics

The official Kafka subscription doc describes these primary topics:

- `behavior_event`: normal behavior events, one message per event
- `user_profile`: user property events
- `item_profile`: business object property events
- `ad_event_v2`: advertising monitoring/unified raw ad events

For application product analytics, start with `behavior_event`.

## Key Fields For Behavior Events

Typical fields used in analysis:

- `header.app_id`: application id; filter to the current application app id
- `event_name`: product event name
- `params`: event params, often encoded as a JSON string
- `user.user_unique_id`: product user id when available
- `user.device_id` or common `device_id`: device identifier depending on exported shape
- `server_time`: ingestion/server timestamp in seconds
- `local_time_ms`: event occurrence timestamp in milliseconds
- `log_type`: event category, including launch/terminate/mario-style event logs

Confirm the actual message shape from a sample before writing final SQL because DataFinder raw schemas can vary by SDK/platform/export path.

## Raw Event Analysis Rules

- Parse `params` as JSON when it is a string.
- Filter by `header.app_id` before aggregation.
- Prefer `local_time_ms` for user behavior timing.
- Use `server_time` for delivery-latency and ingestion diagnostics.
- Deduplicate only after inspecting whether duplicate messages represent retries, repeated user actions, or Kafka replay.
- Keep Kafka consumer group names unique to the analysis task to avoid interfering with production consumers.

## When Kafka Beats OpenAPI

Use Kafka/raw exports when:

- checking first wrong state in the reporting pipeline
- validating whether an event reached DataFinder
- inspecting raw params before DataFinder aggregation
- computing non-standard metrics not expressible in DataFinder DSL
- doing near-real-time monitoring

Use OpenAPI when:

- DataFinder aggregation semantics are desired
- the user wants the same number visible in DataFinder dashboards
- querying existing report/dashboard data
- working with user profile/behavior-flow APIs
