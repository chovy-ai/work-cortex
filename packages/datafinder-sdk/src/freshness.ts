/**
 * 知识新鲜度自检 —— 包自检自己的接口知识（manifest）是否完整、是否对齐官方文档。
 * 这套校验过去在 ability 的 knowledge-update 里跨边界读包 manifest，现收回包内自包含。
 *
 * 判据（与原 check_freshness 的 datafinder 段一致）：
 *   - 任一端点 path_verified=false → 不新鲜
 *   - last_verified_against_docs_at 超过 staleAfterDays（默认 30 天）→ 不新鲜
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Manifest, ManifestEndpoint } from "./client.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface FreshnessReport {
  fresh: boolean;
  unverified: string[];
  ageDays: number | null;
  staleAfterDays: number;
  messages: string[];
}

function ageDays(iso: unknown): number | null {
  if (typeof iso !== "string" || !iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86_400_000);
}

/** 读包内 manifest 做新鲜度自检。可传入 manifest 覆盖（测试用）。 */
export function checkFreshness(staleAfterDays = 30, manifest?: Manifest): FreshnessReport {
  const m = manifest ?? (JSON.parse(readFileSync(join(PKG_ROOT, "manifest.json"), "utf-8")) as Manifest);
  const endpoints = (m.endpoints ?? []) as ManifestEndpoint[];
  const messages: string[] = [];

  const unverified = endpoints.filter((ep) => !ep.path_verified).map((ep) => ep.id);
  if (unverified.length) messages.push(`${unverified.length} endpoints path_verified=false: ${unverified.join(", ")}`);

  const age = ageDays((m as Record<string, unknown>)["last_verified_against_docs_at"]);
  if (age === null) messages.push("manifest 缺少 last_verified_against_docs_at");
  else if (age > staleAfterDays) messages.push(`距上次核对官方文档已 ${age} 天（阈值 ${staleAfterDays}）`);

  return {
    fresh: messages.length === 0,
    unverified,
    ageDays: age,
    staleAfterDays,
    messages,
  };
}
