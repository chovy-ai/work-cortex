/**
 * 异常检测 —— 确定性，纯函数。
 *
 * 输入一段时间序列（末点为被诊断的「当前」值）+ 可选同比值，输出结构化判定：
 * 是否异常、方向、严重度、z 分数、环比、同比、形态（突刺/阶跃/趋势）。
 *
 * 这是 RCA 的 Step 1：先用死规则确认「确实异常」并给出基准，再谈归因。
 * 模型不参与判定本身，只在拿到 verdict 后决定是否继续调查。
 */
import type { SeriesPoint } from "./types.js";

export type AnomalyShape = "spike" | "step" | "trend" | "normal";
export type Severity = "none" | "mild" | "moderate" | "severe";

export interface AnomalyVerdict {
  isAnomaly: boolean;
  direction: "up" | "down" | "flat";
  current: number;
  /** 末点之前的滑动窗口均值，作为基准。 */
  baselineMean: number;
  /** 基准窗口的总体标准差。 */
  baselineStd: number;
  /** (current - mean) / std；std 为 0 时为 null。 */
  zScore: number | null;
  /** 环比：相对前一个点的百分比变化；无前点时 null。 */
  momPct: number | null;
  /** 同比：相对去年同期的百分比变化；未提供同比值时 null。 */
  yoyPct: number | null;
  shape: AnomalyShape;
  severity: Severity;
  warnings: string[];
}

export interface AnomalyOptions {
  /** 触发异常的 z 分数阈值（带宽），默认 2σ。 */
  band?: number;
  /** 去年同期值，用于算同比。 */
  yoyValue?: number;
  /** 判定可信所需的最少基准点数，默认 4。 */
  minBaselinePoints?: number;
}

export function detectAnomaly(series: SeriesPoint[], opts: AnomalyOptions = {}): AnomalyVerdict {
  const band = opts.band ?? 2;
  const minPoints = opts.minBaselinePoints ?? 4;
  const warnings: string[] = [];

  if (series.length < 2) {
    return {
      isAnomaly: false,
      direction: "flat",
      current: series.at(-1)?.value ?? 0,
      baselineMean: series.at(-1)?.value ?? 0,
      baselineStd: 0,
      zScore: null,
      momPct: null,
      yoyPct: null,
      shape: "normal",
      severity: "none",
      warnings: ["序列点数不足（<2），无法判定异常。"],
    };
  }

  const current = series[series.length - 1].value;
  const prev = series[series.length - 2].value;
  const baseline = series.slice(0, -1).map((p) => p.value);

  if (baseline.length < minPoints) {
    warnings.push(`基准点数仅 ${baseline.length}（<${minPoints}），σ 估计不稳，判定仅供参考。`);
  }

  const baselineMean = mean(baseline);
  const baselineStd = std(baseline, baselineMean);
  const zScore = baselineStd > 1e-9 ? (current - baselineMean) / baselineStd : null;

  const momPct = Math.abs(prev) > 1e-9 ? ((current - prev) / prev) * 100 : null;
  const yoyPct =
    opts.yoyValue !== undefined && Math.abs(opts.yoyValue) > 1e-9
      ? ((current - opts.yoyValue) / opts.yoyValue) * 100
      : null;

  // 异常判定：有 σ 时看 z；σ=0（基准恒定）时只要偏离基准即异常。
  let isAnomaly: boolean;
  if (zScore !== null) {
    isAnomaly = Math.abs(zScore) >= band;
  } else {
    isAnomaly = Math.abs(current - baselineMean) > 1e-9;
    if (isAnomaly) warnings.push("基准方差为 0（历史恒定），任何偏离都会被判为异常。");
  }

  const direction: AnomalyVerdict["direction"] =
    current > baselineMean + 1e-9 ? "up" : current < baselineMean - 1e-9 ? "down" : "flat";

  const severity = severityFromZ(zScore, band, isAnomaly);
  const shape = isAnomaly ? classifyShape(series, baselineMean, baselineStd, band) : "normal";

  return {
    isAnomaly,
    direction,
    current,
    baselineMean,
    baselineStd,
    zScore,
    momPct,
    yoyPct,
    shape,
    severity,
    warnings,
  };
}

function severityFromZ(z: number | null, band: number, isAnomaly: boolean): Severity {
  if (!isAnomaly) return "none";
  if (z === null) return "moderate";
  const a = Math.abs(z);
  if (a >= 4) return "severe";
  if (a >= 3) return "moderate";
  if (a >= band) return "mild";
  return "none";
}

/**
 * 形态判定（启发式，确定性）：
 *  - trend：末尾连续 ≥3 个点同向单调变化 → 趋势性漂移。
 *  - step：前一个点也已越过带宽且与当前同向 → 已抬升/下沉的阶跃（非孤立）。
 *  - spike：仅当前点越界，前点仍在基准内 → 单点突刺。
 */
function classifyShape(series: SeriesPoint[], mean: number, std: number, band: number): AnomalyShape {
  const vals = series.map((p) => p.value);
  const n = vals.length;

  // 趋势：最后 4 个点（含当前）严格同向单调
  if (n >= 4) {
    const tail = vals.slice(-4);
    const incr = tail.every((v, i) => i === 0 || v > tail[i - 1]);
    const decr = tail.every((v, i) => i === 0 || v < tail[i - 1]);
    if (incr || decr) return "trend";
  }

  const threshold = std > 1e-9 ? band * std : 1e-9;
  const curDev = vals[n - 1] - mean;
  const prevDev = vals[n - 2] - mean;
  const prevBeyond = Math.abs(prevDev) >= threshold && Math.sign(prevDev) === Math.sign(curDev);
  return prevBeyond ? "step" : "spike";
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** 总体标准差（除以 N，不是 N-1），与基准均值配套。 */
function std(xs: number[], m: number): number {
  if (xs.length === 0) return 0;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}
