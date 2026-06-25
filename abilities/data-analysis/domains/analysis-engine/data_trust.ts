/**
 * 数据可信度门 —— RCA 的 Step 0，确定性硬检查。
 *
 * 「先怀疑数据，再怀疑业务」：在把指标异常归因到业务原因之前，先用死规则排除
 * 口径错配 / 样本不足 / 上报延迟 / 拆分不闭合 / 比率型指标误用 等数据侧问题。
 *
 * 任何 blocking 项未清，引擎都不该继续业务归因——这条由代码强制，模型跳不过。
 */

export interface TrustInputs {
  /** 指标定义是否与 metrics 口径登记一致（调用方对照 metrics.yaml 后断言）。 */
  metricDefinitionMatches?: boolean;
  /** 参与计算的样本量（如去重设备数 / 事件行数）。 */
  sampleSize?: number;
  /** 可接受的最小样本量，默认 100。 */
  minSampleSize?: number;
  /** 关键标识（如 device_id）的空值率，0..1。 */
  nullRate?: number;
  /** 可接受的最大空值率，默认 0.05。 */
  maxNullRate?: number;
  /** 当前窗口是否处于上报延迟 / 数据回补风险区（如统计「今天」而数据未到齐）。 */
  hasReportDelayRisk?: boolean;
  /** 维度拆分对总量的覆盖率（来自 Decomposition.coverage），低则拆分不闭合。 */
  segmentCoverage?: number;
  /** 是否为比率型指标（留存率/转化率）：这类不能用可加性贡献度直接拆。 */
  isRatioMetric?: boolean;
}

export interface TrustReport {
  /** blocking 为空即通过。 */
  pass: boolean;
  /** 必须先解决、否则不应做业务归因。 */
  blocking: string[];
  /** 不阻断但需在结论里显式标注的保留项。 */
  cautions: string[];
}

export function checkDataTrust(inputs: TrustInputs): TrustReport {
  const blocking: string[] = [];
  const cautions: string[] = [];

  const minSample = inputs.minSampleSize ?? 100;
  const maxNull = inputs.maxNullRate ?? 0.05;

  if (inputs.metricDefinitionMatches === false) {
    blocking.push("指标口径与登记定义不一致：先对齐口径再归因，否则在解释一个错误的数字。");
  } else if (inputs.metricDefinitionMatches === undefined) {
    cautions.push("未确认指标口径是否与 metrics 登记一致，建议先核对。");
  }

  if (inputs.sampleSize !== undefined && inputs.sampleSize < minSample) {
    blocking.push(`样本量 ${inputs.sampleSize} < ${minSample}：波动可能来自随机性而非真实变化。`);
  }

  if (inputs.nullRate !== undefined && inputs.nullRate > maxNull) {
    blocking.push(`关键标识空值率 ${(inputs.nullRate * 100).toFixed(1)}% > ${(maxNull * 100).toFixed(0)}%：去重/归并不可靠，先查埋点。`);
  }

  if (inputs.hasReportDelayRisk) {
    blocking.push("当前窗口存在上报延迟/数据回补风险：先排除「假异常」（数据没到齐），再谈业务。");
  }

  if (inputs.segmentCoverage !== undefined && inputs.segmentCoverage < 0.8) {
    cautions.push(`维度拆分仅覆盖 ${(inputs.segmentCoverage * 100).toFixed(0)}% 的总变化：存在缺失 segment，主因结论需保留。`);
  }

  if (inputs.isRatioMetric) {
    cautions.push("比率型指标：不可用可加性贡献度直接拆，需分别拆分子/分母，警惕辛普森悖论。");
  }

  return { pass: blocking.length === 0, blocking, cautions };
}
