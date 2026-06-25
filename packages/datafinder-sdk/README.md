<!-- 本文件由 scripts/gen-readme.ts 从 manifest.json 自动生成，勿手改。 -->
# @workcortex/datafinder-sdk

火山引擎 DataFinder OpenAPI 的灵活 SDK：**manifest 驱动、自描述、每个端点自带官方文档链接**。

- 官方文档根：https://www.volcengine.com/docs/84129
- 端点数：16

## 安装与配置（配置注入）

```ts
import { createDataFinderSDK, loadConfigFromEnv } from "@workcortex/datafinder-sdk";

// 配置无关：调用方传入 .env.local 路径（或直接构造 DataFinderConfig 对象）
const sdk = createDataFinderSDK(loadConfigFromEnv("/abs/path/.env.local"));
```

`.env.local` 需含：`DATAFINDER_BASE_URL` / `DATAFINDER_ACCESS_KEY` / `DATAFINDER_SECRET_KEY` / `DATAFINDER_APP_ID`（可选 `DATAFINDER_PROJECT_ID` / `DATAFINDER_REGION` / `DATAFINDER_SERVICE`）。

## 三种用法

```ts
// 1) 发现 / 自描述（带官方文档链接）
sdk.endpoints();                 // 全部端点摘要 + doc_url
sdk.help("report.query");        // 人话：说明 + 参数 + 官方链接
sdk.docUrl("analysis.query");    // → 官方文档 URL

// 2) 类型化分组方法（参数强类型，JSDoc @see 官方文档）
await sdk.reports.query({ report_id: "123", count: 10 });
await sdk.analysis.query({ dsl });

// 3) 泛化调用（覆盖所有/未来端点）；raw() 取原始响应
await sdk.call("metadata.query", { filter: {} });   // 归一化 DfResult，错误带 docUrl
await sdk.raw("report.query", { report_id: "123" }); // 原始 APIResult
```

结果 `DfResult`：成功 `{ ok:true, result }`（result 为 table/records/scalar/empty），失败 `{ ok:false, code, message, docUrl, retryable }` —— 错误自带官方文档链接便于排查。

## 端点一览

| 端点 | 说明 | 方法 路径 | 必填参数 | 官方文档 |
|---|---|---|---|---|
| `dashboard.list` | List dashboards and reports the account can view, with ids and names. | GET `/datafinder/openapi/v1/{app_id}/dashboards/all` | `app_id:int` | [文档](https://www.volcengine.com/docs/84129/1285228?lang=zh) |
| `dashboard.reports` | List the reports inside one dashboard to resolve report_id from a dashboard name/id. | GET `/datafinder/openapi/v1/{app_id}/dashboards/{dashboard_id}/reports` | `app_id:int` `dashboard_id:string` | [文档](https://www.volcengine.com/docs/84129/1285220?lang=zh) |
| `report.query` | Query one existing DataFinder report's computed data over a time range. Metric definition is owned by the asset. | POST `/datafinder/openapi/v1/{app_id}/reports/{report_id}` | `app_id:int` `report_id:string` | [文档](https://www.volcengine.com/docs/84129/1285240?lang=zh) |
| `analysis.query` | Run an event analysis DSL query and fetch the computed result (trends, distinct users, counts, breakdowns). 请求体 = 分析 DSL 字段（periods/content/resources/version…）直接铺在顶层，并必须带 app_ids 或 project_ids 限定范围；不要包成 {dsl:{...}}。 | POST `/datafinder/openapi/v1/analysis` | `periods:array` `content:object` | [文档](https://www.volcengine.com/docs/84129/1285239?lang=zh) |
| `analysis.result` | Fetch a previously submitted analysis result by result_id (async private-deployment flow). | GET `/datafinder/openapi/v1/analysis/{result_id}/result` | `result_id:string` | [文档](https://www.volcengine.com/docs/84129/1285232?lang=zh) |
| `analysis.download` | Export a large grouped analysis result as CSV/zip beyond normal query row limits. | POST `/datafinder/openapi/v1/{app_id}/downloads` | `app_id:int` | [文档](https://www.volcengine.com/docs/84129/1285237?lang=zh) |
| `metadata.query` | Query metadata: event list, event properties, user properties, virtual events/properties. | POST `/datafinder/openapi/v1/metadata/{app_id}/list/events` | `app_id:int` | [文档](https://www.volcengine.com/docs/84129/1285285?lang=zh) |
| `user.profile` | Fetch one user/device profile, device info, latest user properties, and tags. | POST `/datafinder/openapi/v1/{app_id}/behaviors/profiles` | `app_id:int` `query_type:string` `query_id:string` | [文档](https://www.volcengine.com/docs/84129/1285261?lang=zh) |
| `user.behavior_flow` | Reconstruct one user's event sequence around an anchor timestamp. | POST `/datafinder/openapi/v1/{app_id}/behaviors/flows` | `app_id:int` `query_type:string` `query_id:string` `timestamp:ts_ms` `orientation:string` `count:int` | [文档](https://www.volcengine.com/docs/84129/1285271?lang=zh) |
| `user.query_create` | Create a user-list query from a user analysis definition; returns a query id. | POST `/datafinder/openapi/v1/{app_id}/user_analysis/queries` | `app_id:int` `query_type:string` | [文档](https://www.volcengine.com/docs/84129/1285287?lang=zh) |
| `user.query_result` | Fetch the user-list result for a previously created user query id. | GET `/datafinder/openapi/v1/{app_id}/user_analysis/queries/{query_id}` | `app_id:int` `query_id:string` | [文档](https://www.volcengine.com/docs/84129/1285291?lang=zh) |
| `segment.query` | Fetch sample users for a DataFinder cohort/segment. | GET `/datafinder/openapi/v1/{app_id}/cohorts/{cohort_id}/sample` | `app_id:int` `cohort_id:int` `count:int` | [文档](https://www.volcengine.com/docs/6285/1738909?lang=zh) |
| `tag.v1` | Query/compute/export user tags (Tag V1.0). | POST `/datatag/openapi/v1/app/{app_id}/tag/{tag_name}/download` | `app_id:int` `tag_name:string` `type:string` `condition:object` | [文档](https://www.volcengine.com/docs/84129/1285265?lang=zh) |
| `tag.v2` | Query/compute user tags (Tag V2.0). Requires tenant/project header. | GET `/finder/openApi/v2/cdpMeta/labelSystem/label/historyData` | `tenant_id:string` `id:int` `showNum:int` `startDate:date` `endDate:date` | [文档](https://www.volcengine.com/docs/84129/1285263?lang=zh) |
| `raw_event.export` | List or create raw event/attribute data exports (offline raw event files). | GET `/datarangers/openapi/v1/{app_id}/exports` | `app_id:int` | [文档](https://www.volcengine.com/docs/84129/1285221?lang=zh) |
| `usage.stats` | Query DataFinder product usage/cost statistics by day or month. | POST `/datafinder/openapi/v1/usage_amount` | `app_ids:array` `start_time:ts_ms` `end_time:ts_ms` | [文档](https://www.volcengine.com/docs/84129/1285274?lang=zh) |

> 加端点：在 `manifest.json` 按官方文档登记（见 UPDATE.md），重跑 `npm run gen:readme`。
