/**
 * LLM 决策钩子 —— 「确定性引擎 + LLM 决策」里 LLM 的全部职责，就这几个点。
 *
 * 引擎负责取数、算贡献度、排序、下钻控制（确定性）；只有「有歧义、要结合产品语境」
 * 的判断才回调到这里交给模型：
 *   1. classify        把自然语言问题 → 指标 / 对比窗 / 候选维度
 *   2. selectDimensions 从候选维度里挑哪些值得拆（结合业务语境）
 *   3. shouldDrill      看分解树判断「主因够具体了吗，还要不要再下钻」
 *   4. narrate          把结构化结果翻译成结论叙事
 *
 * 每个钩子都是可选的：引擎对每个点都内置了确定性兜底（见各 default*），
 * 因此整条 RCA 可以在零 LLM 调用下端到端跑通（用于单测 / 回归 / 离线）。
 * 接入到 skill 时，由 agent 用 Claude 实现这些钩子。
 */
import type { Decomposition } from "./contribution.js";
import type { TimeWindow } from "./types.js";

export interface ClassifyResult {
  metric: string;
  window: TimeWindow;
  /** 候选拆解维度（如 ["channel","app_version","os","region","user_type"]）。 */
  candidateDimensions: string[];
}

export interface SelectDimensionsContext {
  candidateDimensions: string[];
  depth: number;
  /** 已选过的维度（下钻时排除，避免重复拆同一维度）。 */
  usedDimensions: string[];
}

export interface ShouldDrillContext {
  /** 当前层选中维度的分解。 */
  decomposition: Decomposition;
  depth: number;
  /** 头号 factor 的 |贡献占比|。 */
  topShare: number;
}

export interface DecisionHooks {
  classify?(question: string): Promise<ClassifyResult>;
  selectDimensions?(ctx: SelectDimensionsContext): Promise<string[]>;
  shouldDrill?(ctx: ShouldDrillContext): Promise<boolean>;
  /** narrate 接收完整 RcaResult（JSON），返回结论文本。引擎不强制调用。 */
  narrate?(result: unknown): Promise<string>;
}

export interface DrillThresholds {
  /** 最大下钻深度，默认 3。 */
  maxDepth: number;
  /** 头号 factor 贡献占比超过此值即认为主因够集中、停止下钻，默认 0.7。 */
  stopWhenTopShare: number;
}

export const DEFAULT_THRESHOLDS: DrillThresholds = { maxDepth: 3, stopWhenTopShare: 0.7 };

/**
 * shouldDrill 的纯阈值兜底（无 LLM）：
 * 深度到顶、或主因已足够集中、或覆盖率过低（拆下去也不可信）→ 停。
 */
export function defaultShouldDrill(ctx: ShouldDrillContext, th: DrillThresholds = DEFAULT_THRESHOLDS): boolean {
  if (ctx.depth + 1 >= th.maxDepth) return false;
  if (ctx.topShare >= th.stopWhenTopShare) return false;
  if (ctx.decomposition.coverage < 0.5) return false;
  return true;
}

/** selectDimensions 的兜底：用全部尚未使用的候选维度。 */
export function defaultSelectDimensions(ctx: SelectDimensionsContext): string[] {
  return ctx.candidateDimensions.filter((d) => !ctx.usedDimensions.includes(d));
}
