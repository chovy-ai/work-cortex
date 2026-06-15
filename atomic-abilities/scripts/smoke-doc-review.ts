// 端到端冒烟：真实拉起 claude 评审一段带 bug 的 diff，打印合 schema 的产出。
// 运行：npm run smoke（需 claude-code-acp 已装 + claude 认证就绪）
import { docReview, AbilityOutputError } from "../index.js";

const diff = [
  "--- a/util.ts",
  "+++ b/util.ts",
  "@@ -1,1 +1,1 @@",
  "-export function add(a: number, b: number) { return a + b }",
  "+export function add(a: number, b: number) { return a - b }",
].join("\n");

try {
  const out = await docReview({ diff, files: ["util.ts"] }, { timeoutMs: 120_000 });
  console.log("✅ doc.review 产出（已通过 output schema 校验）：");
  console.log(JSON.stringify(out, null, 2));
} catch (err) {
  if (err instanceof AbilityOutputError) {
    console.error("产出始终不合 schema：", err.message);
  } else {
    console.error("冒烟失败：", err);
  }
  process.exitCode = 1;
}
