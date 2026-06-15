import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDeclarativeAbility } from "../../core/ability.js";

export interface DocReviewInput {
  diff: string;
  files?: string[];
}

export interface DocReviewIssue {
  file: string;
  line?: number;
  severity: "high" | "med" | "low";
  note: string;
}

export interface DocReviewOutput {
  issues: DocReviewIssue[];
}

// 资产（prompt.md / io.schema.json）从源码目录读取，不依赖 tsc 拷贝。
// 运行位置 dist/abilities/doc-review/ → 包根 → abilities/<name>/。
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..", "..");
const SRC_DIR = join(PKG_ROOT, "abilities", basename(HERE));

/** doc.review · 评审代码改动，产出问题清单。绑定 claude。 */
export const docReview = defineDeclarativeAbility<DocReviewInput, DocReviewOutput>({
  id: "doc.review",
  description: "对代码改动做评审，产出问题清单",
  agent: "claude",
  dir: SRC_DIR,
  limits: { timeoutMs: 120_000, reviseMax: 1 },
});
