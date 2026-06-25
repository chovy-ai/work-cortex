/**
 * DataFinderProvider —— 把 RCA 引擎接到真实 DataFinder OpenAPI。
 *
 * 引擎只认 MetricDataProvider 接口；本适配器用 DataFinderClient.call("analysis.query", dsl)
 * 实现它。两个「app 专属缝」由调用方注入，引擎本身不硬编码任何应用的 DSL：
 *   - buildDsl(spec)        把「指标+区间+分组维度+过滤」编成 analysis.query 的请求体
 *                           （这正是 query-execution 的 compile 步骤已经在做的事，可复用）
 *   - extractSegments(data) 从分组结果里取出 [{segment, value}]（按 app 的报表结构）
 * extractScalar 有通用兜底（沿用 execute.ts 的 date_index/data_item 抽取并求和）。
 *
 * 这样：分析逻辑（贡献度/异常/下钻）完全确定且可单测；与 DataFinder 的耦合收敛到这一个文件。
 */
import type { APIResult, DataFinderClient } from "@workcortex/datafinder-sdk";
import type { MetricDataProvider, Period, SegmentValue, SeriesPoint, TimeWindow } from "./types.js";

export interface MetricQuerySpec {
  metric: string;
  period: Period;
  /** 需要按此维度分组；不传则取总量。 */
  groupBy?: string;
  /** 上层过滤（来自下钻路径）。 */
  filters?: Record<string, string>;
  /** 时间粒度提示，序列查询用 "day"。 */
  granularity?: "day" | "total";
}

export type AnalysisDslBuilder = (spec: MetricQuerySpec, appId: number) => Record<string, unknown>;
export type ScalarExtractor = (apiData: unknown) => number;
export type SeriesExtractor = (apiData: unknown) => SeriesPoint[];

export interface DataFinderProviderOptions {
  appId: number;
  buildDsl: AnalysisDslBuilder;
  /** 分组结果 → [{segment, value}]，app 专属，必填。 */
  extractSegments: (apiData: unknown) => { segment: string; value: number }[];
  /** 单值抽取，默认沿用 series-table 抽取并对首列求和。 */
  extractScalar?: ScalarExtractor;
  /** 日序列抽取，默认沿用 series-table 抽取首列。 */
  extractSeries?: SeriesExtractor;
}

export class DataFinderProvider implements MetricDataProvider {
  constructor(
    private readonly client: DataFinderClient,
    private readonly opts: DataFinderProviderOptions,
  ) {}

  async fetchSeries(metric: string, current: Period, trailingDays: number): Promise<SeriesPoint[]> {
    const start = shiftDate(current.end, -(trailingDays - 1));
    const dsl = this.opts.buildDsl({ metric, period: { start, end: current.end }, granularity: "day" }, this.opts.appId);
    const data = await this.run(dsl);
    return (this.opts.extractSeries ?? defaultExtractSeries)(data);
  }

  async fetchTotal(metric: string, window: TimeWindow, filters?: Record<string, string>): Promise<{ base: number; current: number }> {
    const extract = this.opts.extractScalar ?? defaultExtractScalar;
    const [base, current] = await Promise.all([
      this.run(this.opts.buildDsl({ metric, period: window.base, filters, granularity: "total" }, this.opts.appId)),
      this.run(this.opts.buildDsl({ metric, period: window.current, filters, granularity: "total" }, this.opts.appId)),
    ]);
    return { base: extract(base), current: extract(current) };
  }

  async fetchSegmented(
    metric: string,
    window: TimeWindow,
    dimension: string,
    filters?: Record<string, string>,
  ): Promise<SegmentValue[]> {
    const [baseData, curData] = await Promise.all([
      this.run(this.opts.buildDsl({ metric, period: window.base, groupBy: dimension, filters, granularity: "total" }, this.opts.appId)),
      this.run(this.opts.buildDsl({ metric, period: window.current, groupBy: dimension, filters, granularity: "total" }, this.opts.appId)),
    ]);
    const baseMap = toMap(this.opts.extractSegments(baseData));
    const curMap = toMap(this.opts.extractSegments(curData));
    const segments = new Set([...baseMap.keys(), ...curMap.keys()]);
    return [...segments].map((segment) => ({
      segment,
      base: baseMap.get(segment) ?? 0,
      current: curMap.get(segment) ?? 0,
    }));
  }

  private async run(dsl: Record<string, unknown>): Promise<unknown> {
    const res: APIResult = await this.client.call("analysis.query", dsl);
    if (res.status !== "success") {
      throw new Error(`analysis.query 失败: ${res.error_code} ${res.error_message}`);
    }
    return res.data;
  }
}

function toMap(rows: { segment: string; value: number }[]): Map<string, number> {
  return new Map(rows.map((r) => [r.segment, r.value]));
}

/** ISO 日期偏移 days 天（UTC 算术，避开时区漂移）。 */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── 通用抽取兜底：沿用 execute.ts 在结果里深找 date_index_list + data_item_list 的做法 ──

function findSeriesNode(data: unknown): { dates: unknown[]; items: any[] } | null {
  let node: any = null;
  const seen = new Set<object>();
  const visit = (v: any): void => {
    if (node || !v || typeof v !== "object" || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v["date_index_list"]) && Array.isArray(v["data_item_list"]) && v["data_item_list"].length) {
      node = v;
      return;
    }
    (Array.isArray(v) ? v : Object.values(v)).forEach(visit);
  };
  visit(data);
  return node ? { dates: node["date_index_list"], items: node["data_item_list"] } : null;
}

function defaultExtractSeries(data: unknown): SeriesPoint[] {
  const node = findSeriesNode(data);
  if (!node) return [];
  const first = node.items[0];
  const arr: unknown[] = Array.isArray(first?.["data"]) ? first["data"] : [];
  return node.dates.map((d, i) => ({ date: String(d), value: Number(arr[i] ?? 0) }));
}

function defaultExtractScalar(data: unknown): number {
  return defaultExtractSeries(data).reduce((a, p) => a + p.value, 0);
}
