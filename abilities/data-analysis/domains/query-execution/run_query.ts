#!/usr/bin/env node
/**
 * 查询链路驱动入口（CLI）：把一句自然语言问题灌进 StepScheduler 跑完整条 step 图。
 * 用法：node build/domains/query-execution/run_query.js "昨天 DAU 多少"
 * 需要：claude 认证（understand 的 S1）+ .env.local DataFinder 凭据（execute）。
 */
import { StepScheduler } from "./scheduler/scheduler.js";

const text = process.argv.slice(2).join(" ").trim();
if (!text) {
  console.error('用法: node build/domains/query-execution/run_query.js "<自然语言问题>"');
  process.exit(1);
}

const scheduler = new StepScheduler();
const state = scheduler.new_state({ text });
const final = await scheduler.run(state);

console.log(`status: ${final.status} | run_id: ${final.run_id} | 末步: ${final.current_step}`);
if (final.status === "awaiting_input") {
  console.log("需要补充输入:", JSON.stringify(final.await_payload, null, 2));
} else if (final.status === "failed") {
  console.log("失败:", final.history.at(-1)?.["message"] ?? "(无消息)");
} else {
  console.log("report:", JSON.stringify(final.context["report"], null, 2));
  console.log("charts:", JSON.stringify(final.context["charts"] ?? []));
  console.log(`产物目录: outputs/${final.run_id}/`);
}
