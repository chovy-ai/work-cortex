/**
 * 增量 0 验证 —— 打真实 DataFinder，断言报表回填出真实行。
 * 用法：node dist/scripts/verify.js [envPath] [reportId]
 * 默认 env 取本仓 ability 的 .env.local；默认报表为已知的 PV&UV。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDataFinderSDK, loadConfigFromEnv } from "@workcortex/datafinder-sdk";
import { createAnalyticsQuery } from "../src/engine.js";

// dist/scripts/verify.js → 包根 → 仓库根 → ability .env.local
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const envPath = process.argv[2] ?? resolve(PKG_ROOT, "..", "..", "abilities", "data-analysis", ".env.local");
const reportId = process.argv[3] ?? "7649241423115461888";

const q = createAnalyticsQuery(createDataFinderSDK(loadConfigFromEnv(envPath)));
const r = await q.queryReport(reportId, { count: 7 });

if (!r.ok) {
  process.stderr.write(`FAIL: ${JSON.stringify(r.error)}\n`);
  process.exit(1);
}
if (!r.table || r.table.rows.length === 0) {
  process.stderr.write(`FAIL: 出数为空 ${JSON.stringify(r).slice(0, 300)}\n`);
  process.exit(1);
}
process.stdout.write(`OK source=${r.source}\n`);
process.stdout.write(`columns: ${JSON.stringify(r.table.columns)}\n`);
process.stdout.write(`rows(尾3): ${JSON.stringify(r.table.rows.slice(-3))}\n`);
process.exit(0);
