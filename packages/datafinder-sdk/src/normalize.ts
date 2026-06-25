/** DataFinder 响应 → 统一结果形态（表格 / 记录 / 标量 / 空）。 */

/**
 * 深度搜索响应里的 date_index_list + data_item_list（analysis.query 在顶层、
 * report.query 在 data.dsls[0].data[] —— 同一结构不同深度），抽成「date × 各指标」表格。
 * 找不到返回 null（交给 genericResult 兜底）。
 */
export function normalizeOpenApiData(data: unknown): Record<string, unknown> | null {
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
  if (!node) return null;
  const dates: unknown[] = node["date_index_list"];
  const items: any[] = node["data_item_list"];
  const colNames = items.map((it, i) => {
    const base = it["show_name"] || it["event_show_name"] || it["name"] || `series_${i + 1}`;
    const lbl = it["show_label"] && it["show_label"] !== base ? `(${it["show_label"]})` : "";
    return `${base}${lbl}`;
  });
  const columns = ["date", ...colNames];
  const rows = dates.map((d, i) => [d, ...items.map((it) => (Array.isArray(it["data"]) ? (it["data"][i] ?? null) : null))]);
  return { kind: "table", columns, rows, row_count: rows.length };
}

/** 非时间序列响应的通用包装。 */
export function genericResult(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) return { kind: "records", records: data, row_count: data.length };
  if (data && typeof data === "object") return { kind: "records", records: [data], row_count: 1 };
  return { kind: data == null ? "empty" : "scalar", value: data ?? null };
}
