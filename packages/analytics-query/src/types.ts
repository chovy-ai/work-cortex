/** 查询结果的最小统一契约（小而可生长）。 */

export interface QueryTable {
  columns: string[];
  rows: (string | number | null)[][];
}

/** 一次查询的统一产出：成功带 table（或非表格的归一化 data），失败带 error（含官方文档链接）。 */
export interface QueryResult {
  ok: boolean;
  /** 数据来源标识，如 "report:7649241423115461888"。 */
  source?: string;
  /** 时间序列 / 表格结果（可读）。 */
  table?: QueryTable;
  /** 非表格结果的归一化原貌（records/scalar/empty）。 */
  data?: unknown;
  error?: { code: string; message: string; docUrl?: string };
  warnings: string[];
}
