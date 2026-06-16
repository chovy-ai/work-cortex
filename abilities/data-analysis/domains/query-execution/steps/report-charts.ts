/**
 * 报告环节的图表渲染（workflow，对齐 ARCHITECTURE 第八节「报告 = LLM 叙述 + workflow 渲染表格/图表」）。
 * 查询成功且结果可图时，调 atomic-abilities 的 image.generate（data-analysis/chart 场景，
 * codex 写 matplotlib 等渲染真实数据），返回图片绝对路径。
 * 图表是增强项——不可图 / 失败时返回空数组，绝不阻断报告主体。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageGenerate } from "atomic-abilities";

// 编译后位置 build/domains/query-execution/steps/report-charts.js → 仓库根（上 4 层）
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const OUTPUTS = join(REPO_ROOT, "outputs");

const MAX_ROWS = 200;

export interface ChartRef {
  path: string; // 绝对路径
}

interface ResultBlock {
  kind?: string;
  columns?: string[];
  rows?: unknown[][];
  records?: Record<string, unknown>[];
  row_count?: number;
}

function chartable(r: ResultBlock | undefined): r is ResultBlock {
  if (!r) return false;
  if (r.kind === "table") return (r.rows?.length ?? 0) >= 2 && (r.columns?.length ?? 0) >= 2;
  if (r.kind === "records") return (r.records?.length ?? 0) >= 2;
  return false;
}

/** 结果转紧凑 CSV（限行，避免 prompt 过大），供作图 / 叙述复用。 */
export function describeResult(r: ResultBlock): string {
  if (r.kind === "table" && r.columns && r.rows) {
    const head = r.columns.join(",");
    const body = r.rows.slice(0, MAX_ROWS).map((row) => row.join(",")).join("\n");
    const more = r.rows.length > MAX_ROWS ? `\n…（共 ${r.rows.length} 行，仅取前 ${MAX_ROWS} 行）` : "";
    return `${head}\n${body}${more}`;
  }
  if (r.kind === "records" && r.records && r.records.length) {
    const recs = r.records.slice(0, MAX_ROWS);
    const cols = Object.keys(recs[0] ?? {});
    const head = cols.join(",");
    const body = recs.map((rec) => cols.map((c) => rec[c]).join(",")).join("\n");
    const more = r.records.length > MAX_ROWS ? `\n…（共 ${r.records.length} 条，仅取前 ${MAX_ROWS} 条）` : "";
    return `${head}\n${body}${more}`;
  }
  return "";
}

export async function renderCharts(ctx: Record<string, any>): Promise<ChartRef[]> {
  const er = ctx["execution_result"];
  if (!er || er.status !== "success" || !chartable(er.result)) return [];

  const summary: string = ctx["report_summary"] ?? ctx["intent"]?.summary ?? "数据分析结果";
  const workspace = ctx["run_id"] ? join(OUTPUTS, String(ctx["run_id"]), "charts") : undefined;

  try {
    const out = await imageGenerate(
      {
        prompt: `把下面的查询结果渲染成最合适的数据分析图（背景：${summary}）。数据为 CSV：\n${describeResult(er.result)}`,
        scenario: "data-analysis/chart",
      },
      { workspace },
    );
    return out.images.map((img) => ({ path: join(out.workspace, img.path) }));
  } catch {
    return []; // 图表失败不影响报告主体
  }
}
