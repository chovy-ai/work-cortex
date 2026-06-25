/**
 * analysis-engine —— 确定性分析方法论引擎 + LLM 决策钩子。
 *
 * 把分析师 playbook 工程化：方法论流程、贡献度、异常判定、下钻控制都是确定性代码，
 * 只在「分类 / 选维度 / 是否下钻 / 叙事」4 个判断点回调 LLM。
 * 当前实现：RCA（指标异常归因）。其余 playbook（漏斗 / 留存 / 归因）按同样骨架扩展。
 */
export * from "./types.js";
export * from "./contribution.js";
export * from "./anomaly.js";
export * from "./data_trust.js";
export * from "./decision_hooks.js";
export * from "./rca.js";
export * from "./datafinder_provider.js";
