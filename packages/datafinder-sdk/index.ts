/**
 * @workcortex/datafinder-sdk —— 火山引擎 DataFinder OpenAPI 的灵活 SDK。
 *
 * manifest 驱动、自描述、每个端点自带官方文档链接。
 *   - 发现/自描述：sdk.endpoints() / describe() / docUrl() / help()
 *   - 泛化调用：    sdk.call(id, params) → 归一化 DfResult；sdk.raw(id, params) → 原始 APIResult
 *   - 类型化分组：  sdk.dashboards / reports / analysis / metadata / users / segments / tags / rawEvents / usage
 *
 * 用法：
 *   import { createDataFinderSDK, loadConfigFromEnv } from "@workcortex/datafinder-sdk";
 *   const sdk = createDataFinderSDK(loadConfigFromEnv("/path/to/.env.local"));
 *   const r = await sdk.reports.query({ report_id, count: 10 });
 */
export { DataFinderSDK, createDataFinderSDK } from "./src/sdk.js";
export { type DfResult } from "./src/errors.js";
export { checkFreshness, type FreshnessReport } from "./src/freshness.js";
export { normalizeOpenApiData, genericResult } from "./src/normalize.js";
export {
  DataFinderClient,
  loadConfigFromEnv,
  loadManifest,
  EndpointNotFound,
  type DataFinderConfig,
  type APIResult,
  type Manifest,
  type ManifestEndpoint,
} from "./src/client.js";
export type * from "./src/types.js";
