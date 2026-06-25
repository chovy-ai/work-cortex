/**
 * analysis-engine 单测 —— 证明方法论是确定性、可复现的：
 * 贡献度/异常/可信度算对，且整条 RCA 能在零 LLM（注入内存桩 provider + 阈值兜底）下端到端跑。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { decompose, rankDimensions } from "../domains/analysis-engine/contribution.js";
import { detectAnomaly } from "../domains/analysis-engine/anomaly.js";
import { checkDataTrust } from "../domains/analysis-engine/data_trust.js";
import { RcaEngine, summarizeRca } from "../domains/analysis-engine/rca.js";
import type { Decomposition } from "../domains/analysis-engine/contribution.js";
import type { MetricDataProvider, Period, SegmentValue, SeriesPoint, TimeWindow } from "../domains/analysis-engine/types.js";

// ── 贡献度分解 ──────────────────────────────────────────────────────────────

test("decompose: 贡献占比/百分点/排序/覆盖率都算对", () => {
  // 总体 1000 → 920，跌 80（-8%）。渠道 A 跌 52，B 跌 18，C 涨 -10（即 +10，抵消）。
  const segs: SegmentValue[] = [
    { segment: "A", base: 500, current: 448 }, // -52
    { segment: "B", base: 300, current: 282 }, // -18
    { segment: "C", base: 200, current: 190 }, // -10
  ];
  const d = decompose("channel", segs, { base: 1000, current: 920 });

  assert.equal(d.total.delta, -80);
  assert.ok(Math.abs((d.total.pctChange ?? 0) - -8) < 1e-9);

  // 排序：|delta| 降序 → A, B, C
  assert.deepEqual(d.factors.map((f) => f.segment), ["A", "B", "C"]);

  const a = d.factors[0];
  assert.ok(Math.abs(a.contributionShare - 0.65) < 1e-9, `share=${a.contributionShare}`); // -52/-80
  assert.ok(Math.abs((a.contributionPp ?? 0) - -5.2) < 1e-9, `pp=${a.contributionPp}`); // -52/1000*100

  // 各 pp 之和 = 总百分比变化
  const ppSum = d.factors.reduce((s, f) => s + (f.contributionPp ?? 0), 0);
  assert.ok(Math.abs(ppSum - -8) < 1e-9);

  // 各 share 之和 = 1（完全闭合）
  const shareSum = d.factors.reduce((s, f) => s + f.contributionShare, 0);
  assert.ok(Math.abs(shareSum - 1) < 1e-9);

  assert.ok(Math.abs(d.coverage - 1) < 1e-9);
  assert.ok(Math.abs(d.concentration - 0.65) < 1e-9);
});

test("decompose: 抵消型 segment 贡献为负", () => {
  // 总跌 -50；A 跌 -70（推动），B 涨 +20（抵消 40%）
  const d = decompose("channel", [
    { segment: "A", base: 100, current: 30 },
    { segment: "B", base: 100, current: 120 },
  ], { base: 200, current: 150 });
  const b = d.factors.find((f) => f.segment === "B")!;
  assert.ok(b.contributionShare < 0, "B 抵消跌幅，share 应为负"); // +20 / -50 = -0.4
  assert.ok(Math.abs(b.contributionShare - -0.4) < 1e-9);
});

test("decompose: 残差暴露缺失 segment（覆盖率 < 1 且告警）", () => {
  // 权威总量跌 -100，但拆出来的 segment 只解释了 -60
  const d = decompose("channel", [
    { segment: "A", base: 100, current: 60 }, // -40
    { segment: "B", base: 100, current: 80 }, // -20
  ], { base: 300, current: 200 });
  assert.equal(d.residual.delta, -40); // -100 - (-60)
  assert.ok(d.coverage < 0.8);
  assert.ok(d.warnings.some((w) => w.includes("只解释了")));
});

test("decompose: totalDelta=0 不会产生 NaN，并提示辛普森风险", () => {
  const d = decompose("channel", [
    { segment: "A", base: 100, current: 150 },
    { segment: "B", base: 100, current: 50 },
  ], { base: 200, current: 200 });
  assert.ok(d.factors.every((f) => Number.isFinite(f.contributionShare)));
  assert.ok(d.warnings.some((w) => w.includes("辛普森")));
});

test("rankDimensions: 选集中度×覆盖率最高的维度", () => {
  const total = { base: 1000, current: 900 }; // -100
  const concentrated = decompose("channel", [
    { segment: "A", base: 600, current: 510 }, // -90，主因集中
    { segment: "B", base: 400, current: 390 }, // -10
  ], total);
  const diffuse = decompose("os", [
    { segment: "iOS", base: 500, current: 450 }, // -50
    { segment: "Android", base: 500, current: 450 }, // -50，平摊
  ], total);
  const ranked = rankDimensions([diffuse, concentrated]);
  assert.equal(ranked[0].decomposition.dimension, "channel");
});

// ── 异常检测 ────────────────────────────────────────────────────────────────

test("detectAnomaly: 平稳序列+突跌 → 异常 down + spike", () => {
  const series: SeriesPoint[] = [
    { date: "d1", value: 100 }, { date: "d2", value: 102 }, { date: "d3", value: 99 },
    { date: "d4", value: 101 }, { date: "d5", value: 100 }, { date: "d6", value: 70 },
  ];
  const v = detectAnomaly(series, { band: 2 });
  assert.equal(v.isAnomaly, true);
  assert.equal(v.direction, "down");
  assert.equal(v.shape, "spike");
  assert.ok((v.zScore ?? 0) < -2);
  assert.ok(v.momPct !== null && v.momPct < 0);
});

test("detectAnomaly: 单调下行 → trend", () => {
  const series: SeriesPoint[] = [
    { date: "d1", value: 100 }, { date: "d2", value: 100 }, { date: "d3", value: 100 },
    { date: "d4", value: 90 }, { date: "d5", value: 80 }, { date: "d6", value: 70 },
  ];
  const v = detectAnomaly(series, { band: 2 });
  assert.equal(v.isAnomaly, true);
  assert.equal(v.shape, "trend");
});

test("detectAnomaly: 正常波动不报异常", () => {
  const series: SeriesPoint[] = [
    { date: "d1", value: 100 }, { date: "d2", value: 102 }, { date: "d3", value: 98 },
    { date: "d4", value: 101 }, { date: "d5", value: 99 }, { date: "d6", value: 100 },
  ];
  const v = detectAnomaly(series, { band: 2 });
  assert.equal(v.isAnomaly, false);
  assert.equal(v.shape, "normal");
});

test("detectAnomaly: 同比计算", () => {
  const series: SeriesPoint[] = [
    { date: "d1", value: 100 }, { date: "d2", value: 100 }, { date: "d3", value: 100 },
    { date: "d4", value: 100 }, { date: "d5", value: 80 },
  ];
  const v = detectAnomaly(series, { band: 2, yoyValue: 160 });
  assert.ok(v.yoyPct !== null && Math.abs(v.yoyPct - -50) < 1e-9); // (80-160)/160
});

// ── 数据可信度门 ────────────────────────────────────────────────────────────

test("checkDataTrust: 口径不符/样本不足/上报延迟均 blocking", () => {
  assert.equal(checkDataTrust({ metricDefinitionMatches: false }).pass, false);
  assert.equal(checkDataTrust({ sampleSize: 10, minSampleSize: 100 }).pass, false);
  assert.equal(checkDataTrust({ nullRate: 0.2 }).pass, false);
  assert.equal(checkDataTrust({ hasReportDelayRisk: true }).pass, false);
});

test("checkDataTrust: 干净输入通过，比率型指标给 caution 但不阻断", () => {
  const ok = checkDataTrust({ metricDefinitionMatches: true, sampleSize: 5000, nullRate: 0.01 });
  assert.equal(ok.pass, true);
  const ratio = checkDataTrust({ metricDefinitionMatches: true, sampleSize: 5000, isRatioMetric: true });
  assert.equal(ratio.pass, true);
  assert.ok(ratio.cautions.some((c) => c.includes("辛普森")));
});

// ── 端到端 RCA（零 LLM：内存桩 provider + 阈值兜底钩子）──────────────────────

/** 内存桩：DAU 从 1000 跌到 920；渠道维度主因集中在 A，A 内部再按版本拆主因是 v2.3。 */
class StubProvider implements MetricDataProvider {
  async fetchSeries(_metric: string, _current: Period, _trailing: number): Promise<SeriesPoint[]> {
    return [
      { date: "d1", value: 1000 }, { date: "d2", value: 1010 }, { date: "d3", value: 995 },
      { date: "d4", value: 1005 }, { date: "d5", value: 1000 }, { date: "d6", value: 920 },
    ];
  }
  async fetchTotal(_metric: string, _window: TimeWindow, filters?: Record<string, string>): Promise<{ base: number; current: number }> {
    // 根层总量 1000→920；下钻进 channel=A 后，A 的总量 500→448
    if (filters?.["channel"] === "A") return { base: 500, current: 448 };
    return { base: 1000, current: 920 };
  }
  async fetchSegmented(_metric: string, _window: TimeWindow, dimension: string, filters?: Record<string, string>): Promise<SegmentValue[]> {
    if (dimension === "channel" && !filters?.["channel"]) {
      return [
        { segment: "A", base: 500, current: 448 }, // -52，主因
        { segment: "B", base: 300, current: 290 }, // -10
        { segment: "C", base: 200, current: 182 }, // -18
      ];
    }
    if (dimension === "app_version" && filters?.["channel"] === "A") {
      return [
        { segment: "v2.3", base: 250, current: 200 }, // -50，A 内部主因
        { segment: "v2.2", base: 250, current: 248 }, // -2
      ];
    }
    // 其它维度：平摊，不集中
    if (dimension === "os") {
      return [
        { segment: "iOS", base: 500, current: 460 },
        { segment: "Android", base: 500, current: 460 },
      ];
    }
    return [];
  }
}

test("RcaEngine: 端到端定位主因并下钻（零 LLM）", async () => {
  const engine = new RcaEngine(new StubProvider());
  const window: TimeWindow = {
    base: { start: "2026-06-01", end: "2026-06-07" },
    current: { start: "2026-06-08", end: "2026-06-14" },
  };
  const result = await engine.analyze({
    metric: "dau",
    window,
    candidateDimensions: ["channel", "os", "app_version"],
    trustInputs: { metricDefinitionMatches: true, sampleSize: 5000, nullRate: 0.01 },
    anomaly: { band: 2 },
  });

  assert.equal(result.stopped, undefined, "应完成归因");
  assert.equal(result.trust.pass, true);

  // 根层主切分应选 channel（最集中），主因 A
  assert.ok(result.path.length >= 2, "应至少下钻一层");
  const root = result.path[0];
  assert.equal(root.dimension, "channel");
  assert.equal(root.chosenSegment, "A");

  // 下钻进 A 后应按 app_version 拆，主因 v2.3
  const child = result.path[1];
  assert.equal(child.dimension, "app_version");
  assert.equal(child.chosenSegment, "v2.3");
  assert.equal(child.filters["channel"], "A");

  // summarize 不抛错且包含主因
  const text = summarizeRca(result);
  assert.ok(text.includes("channel"));
  assert.ok(text.includes("A"));
});

test("RcaEngine: 可信度门未过则停，不做归因", async () => {
  const engine = new RcaEngine(new StubProvider());
  const window: TimeWindow = {
    base: { start: "2026-06-01", end: "2026-06-07" },
    current: { start: "2026-06-08", end: "2026-06-14" },
  };
  const result = await engine.analyze({
    metric: "dau",
    window,
    candidateDimensions: ["channel"],
    trustInputs: { hasReportDelayRisk: true },
  });
  assert.ok(result.stopped?.includes("可信度门"));
  assert.equal(result.path.length, 0);
});

test("RcaEngine: 无显著异常则停（除非 force）", async () => {
  class FlatProvider extends StubProvider {
    async fetchSeries(): Promise<SeriesPoint[]> {
      return [
        { date: "d1", value: 1000 }, { date: "d2", value: 1002 }, { date: "d3", value: 998 },
        { date: "d4", value: 1001 }, { date: "d5", value: 999 }, { date: "d6", value: 1000 },
      ];
    }
  }
  const engine = new RcaEngine(new FlatProvider());
  const window: TimeWindow = {
    base: { start: "2026-06-01", end: "2026-06-07" },
    current: { start: "2026-06-08", end: "2026-06-14" },
  };
  const noForce = await engine.analyze({
    metric: "dau", window, candidateDimensions: ["channel"],
    trustInputs: { metricDefinitionMatches: true, sampleSize: 5000 },
  });
  assert.ok(noForce.stopped?.includes("异常"));

  const forced = await engine.analyze({
    metric: "dau", window, candidateDimensions: ["channel"], force: true,
    trustInputs: { metricDefinitionMatches: true, sampleSize: 5000 },
  });
  assert.equal(forced.stopped, undefined);
  assert.ok(forced.path.length >= 1);
});

test("RcaEngine: LLM 决策钩子可覆盖维度选择与下钻", async () => {
  const engine = new RcaEngine(new StubProvider(), {
    // 模拟 LLM：只选 os（即便不集中），且禁止下钻
    selectDimensions: async () => ["os"],
    shouldDrill: async () => false,
  });
  const window: TimeWindow = {
    base: { start: "2026-06-01", end: "2026-06-07" },
    current: { start: "2026-06-08", end: "2026-06-14" },
  };
  const result = await engine.analyze({
    metric: "dau", window, candidateDimensions: ["channel", "os", "app_version"],
    trustInputs: { metricDefinitionMatches: true, sampleSize: 5000 },
    anomaly: { band: 2 },
  });
  assert.equal(result.path.length, 1, "钩子禁止下钻 → 只一层");
  assert.equal((result.path[0].decomposition as Decomposition).dimension, "os");
});
