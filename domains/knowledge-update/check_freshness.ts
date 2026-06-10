#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const nextop = join(root, "..", "nextop");
const maxDocAgeDays = 30;

type CheckResult = [string, string[]];

function loadJson(path: string): any {
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repo, encoding: "utf8", timeout: 15000 }).trim();
  } catch {
    return "";
  }
}

function originHead(repo: string): string {
  if (!existsSync(repo)) return "";
  const remote = git(repo, ["remote", "get-url", "origin"]) || "origin";
  const refs = git(repo, ["ls-remote", remote, "HEAD"]);
  return refs ? refs.split(/\s+/)[0].slice(0, 7) : "";
}

function ageDays(value?: string): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  const timestamp = Date.parse(normalized);
  if (Number.isNaN(timestamp)) return null;
  return Math.floor((Date.now() - timestamp) / 86_400_000);
}

function checkEventKnowledge(): CheckResult {
  const catalog = loadJson(join(root, "knowledge-store", "event-catalog.json"));
  const stored = String(catalog.nextop_commit ?? "");
  const remote = originHead(nextop);
  if (Object.keys(catalog).length === 0) return ["stale", ["knowledge-store/event-catalog.json is missing"]];
  if (remote && stored && !remote.startsWith(stored)) return ["stale", [`nextop_commit ${stored} != origin HEAD ${remote}`]];
  if (!remote) return ["unknown", ["could not read nextop origin HEAD"]];
  return ["fresh", [`nextop_commit ${stored} matches origin HEAD ${remote}`]];
}

function checkDatafinderInterface(): CheckResult {
  const manifest = loadJson(join(root, "domains", "datafinder-interface", "manifest.json"));
  if (Object.keys(manifest).length === 0) return ["stale", ["manifest.json is missing"]];
  const unverified = (manifest.endpoints ?? []).filter((ep: any) => !ep.path_verified).map((ep: any) => ep.id);
  const age = ageDays(manifest.last_verified_against_docs_at);
  const messages: string[] = [];
  if (unverified.length > 0) messages.push(`${unverified.length} endpoints path_verified=false: ${unverified.join(", ")}`);
  if (age === null) messages.push("last_verified_against_docs_at is missing or invalid");
  else if (age > maxDocAgeDays) messages.push(`last_verified_against_docs_at is ${age} days old`);
  if (messages.length > 0) return ["stale", messages];
  return ["fresh", [`${(manifest.endpoints ?? []).length} endpoints verified`]];
}

function checkMetricSemantics(): CheckResult {
  const model = loadJson(join(root, "knowledge-store", "data-model.json"));
  const stored = String(model.nextop_commit ?? "");
  const remote = originHead(nextop);
  if (Object.keys(model).length === 0) return ["stale", ["knowledge-store/data-model.json is missing"]];
  if (stored === "unknown") return ["unknown", ["data-model.json is still a placeholder"]];
  if (remote && stored && !remote.startsWith(stored)) return ["stale", [`nextop_commit ${stored} != origin HEAD ${remote}`]];
  if (!remote) return ["unknown", ["could not read nextop origin HEAD"]];
  return ["fresh", [`nextop_commit ${stored} matches origin HEAD ${remote}`]];
}

const checks: Record<string, () => CheckResult> = {
  "event-knowledge": checkEventKnowledge,
  "datafinder-interface": checkDatafinderInterface,
  "metric-semantics": checkMetricSemantics
};

function main(argv = process.argv.slice(2)): number {
  const target = argv[0];
  if (!target || !checks[target]) {
    console.error("usage: check_freshness.ts <event-knowledge|datafinder-interface|metric-semantics>");
    return 2;
  }
  const [status, messages] = checks[target]();
  console.log(JSON.stringify({ module: target, status, messages }));
  return status === "fresh" ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
