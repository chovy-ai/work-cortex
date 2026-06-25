/**
 * AnalyticsQuery —— 数据查询能力的引擎（验证驱动，从 0 逐颗长）。
 *
 * 依赖注入：构造传入已配置的 DataFinderSDK（本模块配置无关）。
 * 增量 0：只实现唯一确证能出数的路 —— 报表回填（report.query）。
 * 后续增量再加：报表发现+索引、指标↔报表匹配、意图解析、自由分析。
 */
import type { DataFinderSDK } from "@workcortex/datafinder-sdk";
import type { QueryResult, QueryTable } from "./types.js";

export class AnalyticsQuery {
  constructor(private readonly sdk: DataFinderSDK) {}

  /** 增量 0：给定 report_id 取已算好的真实数据（DataFinder 侧已验证可用的路）。 */
  async queryReport(reportId: string, opts: { count?: number } = {}): Promise<QueryResult> {
    const r = await this.sdk.reports.query({ report_id: reportId, count: opts.count });
    if (!r.ok) {
      return { ok: false, error: { code: r.code, message: r.message, docUrl: r.docUrl }, warnings: r.warnings };
    }
    const table = asTable(r.result);
    return { ok: true, source: `report:${reportId}`, table, data: table ? undefined : r.result, warnings: r.warnings };
  }
}

export function createAnalyticsQuery(sdk: DataFinderSDK): AnalyticsQuery {
  return new AnalyticsQuery(sdk);
}

function asTable(result: Record<string, unknown>): QueryTable | undefined {
  if (result["kind"] === "table" && Array.isArray(result["columns"]) && Array.isArray(result["rows"])) {
    return { columns: result["columns"] as string[], rows: result["rows"] as (string | number | null)[][] };
  }
  return undefined;
}
