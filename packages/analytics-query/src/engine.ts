/**
 * AnalyticsQuery —— 数据查询能力的引擎（验证驱动，从 0 逐颗长）。
 *
 * 依赖注入：构造传入已配置的 DataFinderSDK（本模块配置无关）。
 * 增量 0：只实现唯一确证能出数的路 —— 报表回填（report.query）。
 * 后续增量再加：报表发现+索引、指标↔报表匹配、意图解析、自由分析。
 */
import type { DataFinderSDK } from "@workcortex/datafinder-sdk";
import type { QueryResult, QueryTable, ReportRef } from "./types.js";

export class AnalyticsQuery {
  constructor(private readonly sdk: DataFinderSDK) {}

  /**
   * 增量 1：发现所有看板下的报表，铺成扁平索引（report_id/名称/所属看板）。
   * 是"指标→报表匹配"（增量 2）的地基，也可一次性喂给 agent 省去 discovery 轮次。
   * 用 raw() 取原始嵌套结构（dashboard.list → 每看板 dashboard.reports）。
   */
  async listReports(): Promise<ReportRef[]> {
    const dl = await this.sdk.raw("dashboard.list", {});
    if (dl.status !== "success") throw new Error(`dashboard.list 失败：${dl.error_message ?? "unknown"}`);
    const dashboards = (Array.isArray(dl.data) ? dl.data : []) as Record<string, any>[];

    const out: ReportRef[] = [];
    for (const d of dashboards) {
      const did = String(d["dashboard_id"]);
      const rr = await this.sdk.raw("dashboard.reports", { dashboard_id: did });
      if (rr.status !== "success") continue;
      const reports = ((rr.data as any)?.[did]?.reports ?? []) as Record<string, any>[];
      for (const r of reports) {
        out.push({
          report_id: String(r["report_id"]),
          report_name: String(r["report_name"] ?? r["name"] ?? ""),
          report_type: r["report_type"] as string | undefined,
          dashboard_id: did,
          dashboard_name: String(d["name"] ?? ""),
        });
      }
    }
    return out;
  }

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
