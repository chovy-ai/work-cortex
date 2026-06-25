/**
 * RCA 引擎 —— 指标异常归因的确定性状态机。
 *
 * 这是把 prose playbook 工程化的成品：流程、贡献度、下钻控制都是代码（确定、可复现、可单测），
 * 只在 4 个判断点回调 LLM 决策钩子（见 decision_hooks.ts）。没有钩子时用确定性兜底，
 * 整条链路可零 LLM 端到端跑。
 *
 * 流程（对应 playbooks/rca-anomaly.yaml）：
 *   Step 0 数据可信度门      checkDataTrust —— 不过则停，先查数据
 *   Step 1 确认异常          detectAnomaly —— 无异常则停（除非 force）
 *   Step 2–3 选维度 + 分解    rankDimensions / decompose —— 算贡献度并排序
 *   Step 5 下钻              递归进入头号 segment，shouldDrill 控制停止
 */
import type { AnomalyOptions, AnomalyVerdict } from "./anomaly.js";
import { detectAnomaly } from "./anomaly.js";
import type { Decomposition } from "./contribution.js";
import { decompose, rankDimensions } from "./contribution.js";
import { checkDataTrust, type TrustInputs } from "./data_trust.js";
import {
  DEFAULT_THRESHOLDS,
  defaultSelectDimensions,
  defaultShouldDrill,
  type DecisionHooks,
  type DrillThresholds,
} from "./decision_hooks.js";
import type { DrillStep, MetricDataProvider, RcaResult, TimeWindow } from "./types.js";

export interface RcaInput {
  metric: string;
  window: TimeWindow;
  candidateDimensions: string[];
  /** Step 0 可信度门的输入；省略则只做未确认口径的 caution。 */
  trustInputs?: TrustInputs;
  /** 异常检测参数。 */
  anomaly?: AnomalyOptions & { trailingDays?: number };
  /** 即使未判定为异常也强制归因（如用户已确认要拆）。 */
  force?: boolean;
}

export class RcaEngine {
  constructor(
    private readonly provider: MetricDataProvider,
    private readonly hooks: DecisionHooks = {},
    private readonly thresholds: DrillThresholds = DEFAULT_THRESHOLDS,
  ) {}

  async analyze(input: RcaInput): Promise<RcaResult> {
    const warnings: string[] = [];
    const { metric, window } = input;

    // ── Step 0 数据可信度门 ─────────────────────────────────────────────
    const trustReport = checkDataTrust(input.trustInputs ?? {});
    const trust = { pass: trustReport.pass, blocking: trustReport.blocking, cautions: trustReport.cautions };
    if (!trustReport.pass) {
      return {
        metric,
        window,
        trust,
        anomaly: null,
        path: [],
        warnings,
        stopped: "数据可信度门未通过：先解决 blocking 项，不做业务归因。",
      };
    }

    // ── Step 1 确认异常 ────────────────────────────────────────────────
    const trailingDays = input.anomaly?.trailingDays ?? 28;
    const series = await this.provider.fetchSeries(metric, window.current, trailingDays);
    const verdict = detectAnomaly(series, input.anomaly);
    warnings.push(...verdict.warnings);
    if (!verdict.isAnomaly && !input.force) {
      return {
        metric,
        window,
        trust,
        anomaly: verdict,
        path: [],
        warnings,
        stopped: "未检出显著异常（z 在带宽内）：无需归因。如仍要拆，置 force=true。",
      };
    }

    // ── Step 2–5 选维度 + 分解 + 下钻 ──────────────────────────────────
    const path = await this.investigate(metric, window, input.candidateDimensions, {}, 0, [], warnings);

    return { metric, window, trust, anomaly: verdict, path, warnings };
  }

  /** 递归下钻：每层选一个最具解释力的维度切分，进入头号 segment 继续。 */
  private async investigate(
    metric: string,
    window: TimeWindow,
    candidateDimensions: string[],
    filters: Record<string, string>,
    depth: number,
    usedDimensions: string[],
    warnings: string[],
  ): Promise<DrillStep[]> {
    const selectCtx = { candidateDimensions, depth, usedDimensions };
    const selected = this.hooks.selectDimensions
      ? await this.hooks.selectDimensions(selectCtx)
      : defaultSelectDimensions(selectCtx);
    if (selected.length === 0) return [];

    // 取该层权威总量（带上层过滤），作为每个候选维度分解的总量基准 → 能算残差/覆盖率。
    const total = await this.provider.fetchTotal(metric, window, filters);

    const decomps: Decomposition[] = [];
    for (const dim of selected) {
      const segments = await this.provider.fetchSegmented(metric, window, dim, filters);
      decomps.push(decompose(dim, segments, total));
    }

    const ranked = rankDimensions(decomps);
    if (ranked.length === 0) return [];
    const best = ranked[0].decomposition;
    warnings.push(...best.warnings);

    if (best.factors.length === 0) return [];
    const top = best.factors[0];
    const step: DrillStep = {
      depth,
      dimension: best.dimension,
      decomposition: best,
      chosenSegment: top.segment,
      filters: { ...filters },
    };

    const topShare = Math.abs(top.contributionShare);
    const drillCtx = { decomposition: best, depth, topShare };
    const drill = this.hooks.shouldDrill
      ? await this.hooks.shouldDrill(drillCtx)
      : defaultShouldDrill(drillCtx, this.thresholds);

    const remaining = selected.filter((d) => d !== best.dimension);
    if (!drill || remaining.length === 0) return [step];

    const childPath = await this.investigate(
      metric,
      window,
      remaining,
      { ...filters, [best.dimension]: top.segment },
      depth + 1,
      [...usedDimensions, best.dimension],
      warnings,
    );
    return [step, ...childPath];
  }
}

/** 把 RcaResult 压成一行行人读摘要（供日志 / 兜底，非最终叙事——叙事走 narrate 钩子）。 */
export function summarizeRca(result: RcaResult): string {
  const lines: string[] = [];
  const v = result.anomaly as AnomalyVerdict | null;
  if (result.stopped) {
    lines.push(`[停止] ${result.stopped}`);
    if (result.trust.blocking.length) lines.push(`  blocking: ${result.trust.blocking.join("; ")}`);
    return lines.join("\n");
  }
  if (v) {
    const pct = v.zScore !== null ? `z=${v.zScore.toFixed(2)}` : "z=NA";
    lines.push(`[异常] ${result.metric} ${v.direction} ${pct} 形态=${v.shape} 严重度=${v.severity}`);
  }
  for (const step of result.path) {
    const d = step.decomposition as Decomposition;
    const top = d.factors[0];
    const pp = top.contributionPp !== null ? `${top.contributionPp.toFixed(1)}pp` : "NA";
    lines.push(
      `  ${"  ".repeat(step.depth)}维度 ${d.dimension}: 主因 ${top.segment} ` +
        `贡献 ${(top.contributionShare * 100).toFixed(0)}% (${pp}) | 覆盖率 ${(d.coverage * 100).toFixed(0)}%`,
    );
  }
  if (result.trust.cautions.length) lines.push(`  [保留] ${result.trust.cautions.join("; ")}`);
  return lines.join("\n");
}
