# analysis-engine — 确定性分析方法论引擎 + LLM 决策钩子

把资深分析师的方法论**工程化**：方法论流程、贡献度计算、异常判定、下钻控制全是确定性代码（确定、可复现、可单测），只在「有歧义、需结合产品语境」的判断点回调 LLM。

这是对「纯 skill 太靠模型智能」的回应——方法论不再是给模型读的散文（每次祈祷它照做），而是**代码强制执行的流程**，模型降级为「路由器 + 裁判 + 解说」。

当前实现一个 playbook：**RCA（指标异常归因）**。其余（漏斗 / 留存 / 归因）按同一骨架扩展。

## 谁算、谁判

| 确定性代码（引擎） | LLM 决策钩子（`decision_hooks.ts`） |
|---|---|
| 取数（`MetricDataProvider`） | `classify` 问题 → 指标 / 对比窗 / 候选维度 |
| 基准 / σ / 同比 / 环比（`anomaly.ts`） | `selectDimensions` 该层拆哪些维度 |
| 维度拆解 + 贡献度 + 排序（`contribution.ts`） | `shouldDrill` 主因够具体了吗、还下钻吗 |
| 数据可信度硬检查（`data_trust.ts`） | `narrate` 把结构化结果翻成结论 |
| 递归下钻控制（`rca.ts`） | |

每个钩子都**可选**：引擎对每点都有确定性兜底（阈值/全维度），所以整条 RCA 能**零 LLM** 端到端跑（单测即如此）。接到 skill 时由 agent 用 Claude 实现这些钩子。

## 流程（对应 `playbooks/rca-anomaly.yaml`）

```
Step 0 数据可信度门  checkDataTrust   —— 不过则停：先查口径/样本/上报延迟，不做业务归因
Step 1 确认异常      detectAnomaly    —— 无显著异常则停（除非 force）；给基准+形态(spike/step/trend)
Step 2 选维度        selectDimensions —— LLM 从合法候选里挑（兜底=全部未用）
Step 3 分解          decompose+rank   —— 算各 segment 贡献度、暴露残差/覆盖率、选最具解释力维度
Step 5 下钻          shouldDrill      —— 进入头号 segment 递归（兜底=主因够集中或到深度上限即停）
收敛   叙事          narrate          —— 结论先行模板
```

## 用法

```ts
import { RcaEngine, DataFinderProvider } from "domains/analysis-engine/index.js";
import { DataFinderClient, loadConfigFromEnv } from "domains/datafinder-interface/index.js";

const client = new DataFinderClient(loadConfigFromEnv());
const provider = new DataFinderProvider(client, {
  appId: client.config.app_id,
  buildDsl: (spec, appId) => /* 编 analysis.query 请求体——复用 query-execution 的 compile */,
  extractSegments: (data) => /* 从分组结果取 [{segment, value}]，按 app 报表结构 */,
});

const engine = new RcaEngine(provider, {
  // agent 用 Claude 实现这些（不传则走确定性兜底）
  selectDimensions: async (ctx) => /* … */,
  shouldDrill:      async (ctx) => /* … */,
});

const result = await engine.analyze({
  metric: "dau",
  window: { base: {start,end}, current: {start,end} },
  candidateDimensions: ["channel","app_version","os","region","user_type"], // 来自 app.config 维度注册表
  trustInputs: { metricDefinitionMatches: true, sampleSize, nullRate, hasReportDelayRisk },
  anomaly: { band: 2, yoyValue },
});
// result.path = 下钻路径（每层维度+主因+贡献度）；result.anomaly = 判定；result.trust = 可信度
```

`DataFinderProvider` 把与 DataFinder 的耦合收敛到一个文件，两个「app 专属缝」（`buildDsl` / `extractSegments`）由调用方注入——正是 `query-execution` 已经在做的事，不在引擎里硬编码任何应用 DSL。

## 设计要点

- **可加性指标专用**：`decompose` 适用于 DAU/次数/金额等（segment 之和 ≈ 总量）。比率型指标（留存率/转化率）不能直接拆，由 `data_trust` 的 `isRatioMetric` 标记拦截——需先拆分子/分母，否则踩辛普森悖论。
- **残差与覆盖率必须暴露**：拆分没还原出总量（缺失 segment / 采样）时 `coverage<1` 并告警，绝不假装闭合。
- **抵消型贡献为负**：总体下跌时反而在涨的 segment，贡献占比为负（抵消跌幅），如实呈现。

## 扩展新 playbook

1. 在 `playbooks/<id>.yaml` 写声明式 spec（哪些 step 是 `by:code`、哪些 `by:llm`）。
2. 复用 `contribution.ts` / `anomaly.ts` 或新增确定性算子（纯函数，配单测）。
3. 仿 `rca.ts` 写编排状态机，决策点走 `decision_hooks.ts`。
4. 在 `tests/analysis-engine.test.ts` 加桩 provider 的端到端用例（必须能零 LLM 跑通）。

## 测试

```
npm run build:tools && node --test build/tests/analysis-engine.test.js
```
