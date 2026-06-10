# 火山引擎 DataFinder OpenAPI 能力选择

This file is the routing reference for deciding whether DataFinder OpenAPI can answer a nextop analytics question. Prefer official links over copied endpoint details so documentation changes remain visible.

## Start Here

- Product documentation root: https://www.volcengine.com/docs/84129
- Calling method, service addresses, AK/SK signing, and SDK usage: https://www.volcengine.com/docs/84129/1261794?lang=zh
- OpenAPI FAQ and known limitations: https://www.volcengine.com/docs/84129/1563654

Important environment rule: OpenAPI service addresses differ by DataFinder environment. SaaS cloud-native / domestic non-cloud-native use `https://analytics.volcengineapi.com`; BytePlus overseas uses `https://analytics.byteplusapi.com`; private deployments use the private Finder domain. Confirm this before making requests.

## Capability Map

| Need | Prefer | Official docs | Notes |
| --- | --- | --- | --- |
| Understand auth, base URL, SDK request wrapper | Calling method | https://www.volcengine.com/docs/84129/1261794?lang=zh | Required before any OpenAPI call. Uses AK/SK signing. |
| Discover dashboards and reports the account can view | Dashboard/report OpenAPI | https://www.volcengine.com/docs/84129/1285218 | Use when user references an existing DataFinder dashboard or report. |
| Query one report's metadata and data | Report data API | https://www.volcengine.com/docs/84129/1285240?lang=zh | Use for existing report reuse. `count` max is documented as 1000 for report query results. |
| Run event analysis DSL and fetch computed result | Analysis OpenAPI | https://www.volcengine.com/docs/84129/1285232 | Use for DAU trends, event counts, distinct users, grouping, retention/funnel-like DSL that DataFinder supports. Private deployment flow may return a `result_id` first, then fetch result. |
| Export large grouped analysis result as CSV/zip | Downloads API | https://www.volcengine.com/docs/84129/1285237 | Use when event analysis OpenAPI row limits are insufficient. Docs mention up to 1,000,000 rows for this download path. |
| Investigate one user's profile, device info, latest user props, tags | User profile API | https://www.volcengine.com/docs/84129/1285261 | Use for debugging a single user/device identity or enriching a behavioral case study. |
| Reconstruct a user's behavior sequence around a timestamp | Behavior flow API | https://www.volcengine.com/docs/84129/1285271?lang=zh | Use for user-level timeline analysis. Supports query types such as `user_unique_id`, `ssid`, `web_id`, and `device_id` via the common behavior API docs. |
| Understand behavior/user-analysis common parameters | User analysis common API docs | https://www.volcengine.com/docs/84129/1285278 | Use before profile/flow/user-list APIs. |
| Create/query/export user-list results from user analysis | User query result APIs | https://www.volcengine.com/docs/84129/1285291 | Use when the output is a user list rather than aggregate metrics. |
| Work with user tags V1.0 | Tag V1 common docs | https://www.volcengine.com/docs/84129/1285244 | Use only when the environment requires V1 tags. |
| Work with user tags V2.0 | Tag V2 common docs | https://www.volcengine.com/docs/84129/1285256?lang=zh | Prefer for SaaS cloud-native and supported newer private deployments. |
| Query one tag's metadata | Tag metadata API | https://www.volcengine.com/docs/84129/1285270 | Requires the documented tenant/project header. |

## Selection Rules

Use dashboard/report APIs when:

- the user asks to read an existing dashboard/report
- parity with DataFinder UI is more important than custom computation
- the report owner already encoded complex filters/dimensions

Use analysis DSL APIs when:

- the user asks for metric time series, breakdowns, event user counts, event counts, conversion-like analysis, or DAU growth
- the requested metric can be represented in DataFinder analysis DSL
- the result should match DataFinder's computed aggregation layer

Use downloads API when:

- the analysis result can exceed normal API row limits
- the user needs CSV/zip output
- the request is batch/offline and latency is less important

Use behavior/profile APIs when:

- investigating one user/device
- validating identity stitching
- explaining why one user's activity does or does not appear in aggregate metrics

Use tag APIs when:

- the question explicitly depends on user tags or CDP label metadata
- segment definitions are stored as tags

Use Kafka/raw event data instead of OpenAPI when:

- the user needs raw event fields not exposed by OpenAPI
- event delivery, duplication, malformed params, or SDK mapping is under investigation
- the metric needs custom logic that DataFinder DSL cannot express
- near-real-time consumption is required

## Known Decision Risks

- OpenAPI environment mismatch can return empty or misleading results. Always verify environment and base URL.
- Dashboard/report APIs may return cached computed data. The FAQ states dashboard query OpenAPI does not provide a cache refresh parameter.
- Multi-dimensional table dashboards are not reliably queryable through the normal report API path per the FAQ.
- Time filter semantics depend on granularity. Ensure period granularity matches the requested daily/monthly output.
- For user segment exports, prefer streaming interfaces for very large user lists when documented limits apply.
