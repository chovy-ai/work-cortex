/**
 * 贡献度分解 —— 引擎的数学心脏，纯函数、无 I/O、可单测。
 *
 * 给定一个指标在某维度上各 segment 的 base/current 值，以及（可选的）权威总量，
 * 计算每个 segment 对「总变化量」的贡献，并暴露归因质量信号（覆盖率、集中度、残差）。
 *
 * 这是「不靠模型智能」的关键：贡献度和排序是死算出来的，换任何模型都不会变。
 * 模型只在拿到这棵分解树之后做判断（要不要继续下钻、怎么解释），见 rca.ts / decision_hooks.ts。
 *
 * 适用范围：可加性指标（DAU、次数、金额……，segment 之和 ≈ 总量）。
 * 比率型指标（留存率、转化率）不能这样直接拆——必须先拆分子/分母，否则会踩辛普森悖论；
 * 这类指标由 data_trust 标记 isRatioMetric 拦截，不走本函数。
 */
import type { SegmentValue } from "./types.js";

/** 单个 segment 的归因结果。 */
export interface Factor {
  segment: string;
  base: number;
  current: number;
  /** current - base，该 segment 自身的变化量。 */
  delta: number;
  /**
   * 贡献占比 = delta / totalDelta。
   * 解读：与总变化同号 → 推动了这次变化；异号（负）→ 抵消了这次变化。
   * 例：总体 DAU 下跌时，某渠道 share=0.65 表示它贡献了 65% 的跌幅；
   *     share=-0.1 表示该渠道反而在涨、抵消了 10% 的跌幅。
   * totalDelta 为 0 时为 0（并在 Decomposition.warnings 里说明）。
   */
  contributionShare: number;
  /**
   * 贡献的百分点 = delta / totalBase * 100。
   * 各 segment 的 pp 相加 = 总体百分比变化，便于「下跌 -8% 中，渠道 A 贡献 -5.2pp」式表达。
   * totalBase 为 0 时为 null。
   */
  contributionPp: number | null;
}

/** 一个维度上的完整分解结果。 */
export interface Decomposition {
  dimension: string;
  total: {
    base: number;
    current: number;
    delta: number;
    /** 百分比变化；base 为 0 时为 null。 */
    pctChange: number | null;
  };
  /** 各 segment，按 |delta| 降序（贡献最大的在前）。 */
  factors: Factor[];
  /**
   * 残差 = 总变化量 - 各 segment 变化量之和。
   * 不为 0 说明这个维度的拆分没还原出总量（有缺失 segment / 采样 / “其他”桶），
   * 是「数据可信度」的硬信号，必须暴露而不是藏起来。
   */
  residual: { delta: number; share: number };
  /** 覆盖率 = 1 - |residual.delta| / |totalDelta|，这个维度的拆分解释了多少总变化。 */
  coverage: number;
  /** 集中度 = 头号 factor 的 |contributionShare|，越高说明主因越单一、越好下结论。 */
  concentration: number;
  warnings: string[];
}

const EPS = 1e-9;

/**
 * 把某维度的各 segment 分解成带贡献度的 factor 列表。
 *
 * @param dimension          维度名（如 "channel" / "app_version"）。
 * @param segments           该维度下每个 segment 的 base/current 值。
 * @param authoritativeTotal 可选：独立取到的权威总量（base/current）。提供则据此算残差/覆盖率；
 *                           不提供则以各 segment 之和为总量（coverage 恒为 1，但无法发现缺失 segment）。
 */
export function decompose(
  dimension: string,
  segments: SegmentValue[],
  authoritativeTotal?: { base: number; current: number },
): Decomposition {
  const warnings: string[] = [];

  const segBase = sum(segments.map((s) => s.base));
  const segCurrent = sum(segments.map((s) => s.current));

  const totalBase = authoritativeTotal ? authoritativeTotal.base : segBase;
  const totalCurrent = authoritativeTotal ? authoritativeTotal.current : segCurrent;
  const totalDelta = totalCurrent - totalBase;

  const pctChange = Math.abs(totalBase) > EPS ? (totalDelta / totalBase) * 100 : null;
  if (pctChange === null) {
    warnings.push("base 期总量为 0，无法计算百分比变化，只给绝对量。");
  }

  const totalDeltaIsZero = Math.abs(totalDelta) <= EPS;
  if (totalDeltaIsZero) {
    warnings.push("总量在两期之间没有净变化（totalDelta≈0）：贡献占比无意义。注意可能是各 segment 此消彼长（辛普森式），请逐 segment 看 delta。");
  }

  const factors: Factor[] = segments.map((s) => {
    const delta = s.current - s.base;
    return {
      segment: s.segment,
      base: s.base,
      current: s.current,
      delta,
      contributionShare: totalDeltaIsZero ? 0 : delta / totalDelta,
      contributionPp: Math.abs(totalBase) > EPS ? (delta / totalBase) * 100 : null,
    };
  });
  // 按绝对变化量降序：贡献最大的（无论推动还是抵消）排最前。
  factors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  const segDeltaSum = sum(factors.map((f) => f.delta));
  const residualDelta = totalDelta - segDeltaSum;
  const residual = {
    delta: residualDelta,
    share: totalDeltaIsZero ? 0 : residualDelta / totalDelta,
  };

  let coverage: number;
  if (totalDeltaIsZero) {
    coverage = Math.abs(residualDelta) <= EPS ? 1 : 0;
  } else {
    coverage = 1 - Math.abs(residualDelta) / Math.abs(totalDelta);
  }
  if (coverage < 0.8 && !totalDeltaIsZero) {
    warnings.push(
      `维度 '${dimension}' 只解释了 ${(coverage * 100).toFixed(0)}% 的总变化（残差 ${residualDelta.toFixed(1)}）：可能有缺失 segment 或采样，归因到此维度需保留。`,
    );
  }

  const concentration = factors.length > 0 ? Math.abs(factors[0].contributionShare) : 0;

  return {
    dimension,
    total: { base: totalBase, current: totalCurrent, delta: totalDelta, pctChange },
    factors,
    residual,
    coverage,
    concentration,
    warnings,
  };
}

/**
 * 在多个候选维度的分解里挑出「最具解释力」的那个，用于决定主切分维度。
 * 评分 = 集中度 × max(覆盖率, 0)：既要主因单一，又要拆分能还原总量。
 * 返回按评分降序的 (decomposition, score) 列表，引擎/钩子据此选维度。
 */
export function rankDimensions(decomps: Decomposition[]): { decomposition: Decomposition; score: number }[] {
  return decomps
    .map((d) => ({ decomposition: d, score: d.concentration * Math.max(d.coverage, 0) }))
    .sort((a, b) => b.score - a.score);
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
