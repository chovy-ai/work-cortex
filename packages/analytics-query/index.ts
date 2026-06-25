/**
 * @workcortex/analytics-query —— 数据查询能力（验证驱动，从 0 打磨）。
 *
 * 把查询意图变成 @workcortex/datafinder-sdk 调用并出数。配置无关：构造时注入已配置的 SDK。
 *
 *   import { createDataFinderSDK, loadConfigFromEnv } from "@workcortex/datafinder-sdk";
 *   import { createAnalyticsQuery } from "@workcortex/analytics-query";
 *   const q = createAnalyticsQuery(createDataFinderSDK(loadConfigFromEnv(envPath)));
 *   const r = await q.queryReport("7649241423115461888", { count: 7 });
 */
export { AnalyticsQuery, createAnalyticsQuery } from "./src/engine.js";
export type { QueryResult, QueryTable, ReportRef } from "./src/types.js";
