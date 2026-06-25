/**
 * analysis-engine 共享类型。
 *
 * 设计原则：把「会算的东西」全部定义成确定性数据结构，引擎只产出结构化结果、
 * 不下任何自然语言结论。叙事/判断交给 LLM 决策钩子（见 decision_hooks.ts）。
 */

/** 一个绝对日期区间（含端点），ISO `YYYY-MM-DD`。 */
export interface Period {
  start: string;
  end: string;
}

/**
 * 归因用的「对比窗」：current 是被诊断的异常期，base 是参照期（上一周期 / 去年同期）。
 * 所有归因都是「current 相对 base 的变化量」的分解。
 */
export interface TimeWindow {
  current: Period;
  base: Period;
}

/** 时间序列上的一个点（异常检测用）。 */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** 某维度下一个取值（segment）在 base / current 两期的指标值。 */
export interface SegmentValue {
  segment: string;
  base: number;
  current: number;
}

/**
 * 取数 provider —— 引擎与具体数据源（DataFinder / Kafka / 本地）的唯一耦合点。
 * 引擎只认这个接口；真实实现见 datafinder_provider.ts，测试注入内存桩。
 * 这样「分析逻辑」与「取数」彻底解耦，引擎可在无凭据、无网络下被单测。
 */
export interface MetricDataProvider {
  /** 取末点为「当前」的一段时间序列，供异常检测；trailingDays 为回看天数。 */
  fetchSeries(metric: string, current: Period, trailingDays: number): Promise<SeriesPoint[]>;
  /** 取指标在 base/current 两期的权威总量（可带上层维度过滤）。 */
  fetchTotal(metric: string, window: TimeWindow, filters?: Record<string, string>): Promise<{ base: number; current: number }>;
  /** 取某维度各 segment 在 base/current 两期的值（可带上层维度过滤）。 */
  fetchSegmented(
    metric: string,
    window: TimeWindow,
    dimension: string,
    filters?: Record<string, string>,
  ): Promise<SegmentValue[]>;
}

// 引擎产出（结构化结果，无自然语言结论）——放在 types 里避免模块间循环依赖。

/** 下钻路径上的一层。 */
export interface DrillStep {
  depth: number;
  /** 选中的主切分维度。 */
  dimension: string;
  /** 该层的完整分解（见 contribution.ts 的 Decomposition；此处用宽松类型避免循环 import）。 */
  decomposition: unknown;
  /** 选中、继续下钻进去的 segment（头号 factor）。 */
  chosenSegment: string;
  /** 当前层进入时的上层过滤条件。 */
  filters: Record<string, string>;
}

/** 一次完整 RCA 调查的结构化结果。 */
export interface RcaResult {
  metric: string;
  window: TimeWindow;
  /** Step 0 数据可信度门。 */
  trust: { pass: boolean; blocking: string[]; cautions: string[] };
  /** Step 1 异常判定（见 anomaly.ts 的 AnomalyVerdict）。 */
  anomaly: unknown;
  /** Step 2–5 下钻路径，从根到最细。空数组表示未做归因（如未通过可信度门或无异常）。 */
  path: DrillStep[];
  warnings: string[];
  /** 引擎是否提前停止（未通过可信度门 / 无异常 / 无可用维度）及原因。 */
  stopped?: string;
}

