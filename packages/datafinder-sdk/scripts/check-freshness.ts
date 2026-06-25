/**
 * 知识新鲜度自检 CLI：node dist/scripts/check-freshness.js [staleAfterDays]
 * 不新鲜则退出码 1（可挂 CI / 定时核对官方文档）。
 */
import { checkFreshness } from "../src/freshness.js";

const staleAfterDays = process.argv[2] ? Number(process.argv[2]) : 30;
const r = checkFreshness(staleAfterDays);
if (r.fresh) {
  process.stdout.write(`datafinder-sdk knowledge: fresh (age ${r.ageDays}d / ${r.staleAfterDays}d, 0 unverified)\n`);
  process.exit(0);
}
process.stderr.write("datafinder-sdk knowledge STALE:\n" + r.messages.map((m) => `  - ${m}`).join("\n") + "\n");
process.exit(1);
