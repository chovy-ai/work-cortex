#!/usr/bin/env node
/** Freshness checks for data-analysis knowledge domains. */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataAnalysisRoot, loadAppConfig, resolveOutput, resolveTargetRepo } from "../app-config/config.js";

/** Resolve to an absolute, symlink-free path (Python Path.resolve equivalent). */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

const ROOT = dataAnalysisRoot(resolvePath(fileURLToPath(import.meta.url)));
const CONFIG = loadAppConfig(ROOT);
const APP_REPO = resolveTargetRepo(null, ROOT);
const MAX_DOC_AGE_DAYS = 30;

function loadJson(p: string): Record<string, any> {
  if (!fs.existsSync(p)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    return "";
  }
  return (result.stdout ?? "").trim();
}

function originHead(repo: string): string {
  if (!fs.existsSync(repo)) {
    return "";
  }
  const remote = git(repo, "remote", "get-url", "origin") || "origin";
  const refs = git(repo, "ls-remote", remote, "HEAD");
  return refs ? refs.split(/\s+/)[0]!.slice(0, 7) : "";
}

/**
 * Parse an ISO 8601 datetime string as UTC epoch milliseconds
 * (datetime.fromisoformat equivalent; naive values are treated as UTC,
 * matching `checked.replace(tzinfo=timezone.utc)`).
 */
function parseIsoUtc(value: string): number | null {
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?)?(?:([+-])(\d{2}):?(\d{2})(?::\d{2}(?:[.,]\d{1,6})?)?)?$/,
  );
  if (!m) {
    return null;
  }
  const g: Array<string | undefined> = m;
  const [, y, mo, d, h, mi, s, frac, offSign, offH, offM] = g;
  const ms = frac ? Math.floor(Number(frac.padEnd(6, "0")) / 1000) : 0;
  // Validate calendar fields the way fromisoformat would reject e.g. month 13.
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1
    || (h !== undefined && Number(h) > 23) || (mi !== undefined && Number(mi) > 59)
    || (s !== undefined && Number(s) > 59)) {
    return null;
  }
  let epoch = Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    h !== undefined ? Number(h) : 0, mi !== undefined ? Number(mi) : 0,
    s !== undefined ? Number(s) : 0, ms,
  );
  const check = new Date(epoch);
  if (check.getUTCMonth() + 1 !== Number(mo) || check.getUTCDate() !== Number(d)) {
    return null;
  }
  if (offSign) {
    const offsetMs = (Number(offH) * 60 + Number(offM)) * 60 * 1000;
    epoch += offSign === "+" ? -offsetMs : offsetMs;
  }
  return epoch;
}

function ageDays(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  let epoch = parseIsoUtc(value.split("Z").join("+00:00"));
  if (epoch === null) {
    epoch = parseIsoUtc(`${value}T00:00:00+00:00`);
    if (epoch === null) {
      return null;
    }
  }
  return Math.floor((Date.now() - epoch) / 86400000);
}

function checkEventKnowledge(): [string, string[]] {
  const catalog = loadJson(resolveOutput(CONFIG.output.eventCatalog, ROOT));
  const stored = String(catalog["source_commit"] ?? "");
  const remote = originHead(APP_REPO);
  if (Object.keys(catalog).length === 0) {
    return ["stale", ["knowledge-store/event-catalog.json is missing"]];
  }
  if (remote && stored && !remote.startsWith(stored)) {
    return ["stale", [`source_commit ${stored} != origin HEAD ${remote}`]];
  }
  if (!remote) {
    return ["unknown", ["could not read app repo origin HEAD"]];
  }
  return ["fresh", [`source_commit ${stored} matches origin HEAD ${remote}`]];
}

function checkDatafinderInterface(): [string, string[]] {
  const manifest = loadJson(path.join(ROOT, "domains", "datafinder-interface", "manifest.json"));
  if (Object.keys(manifest).length === 0) {
    return ["stale", ["manifest.json is missing"]];
  }
  const endpoints: Record<string, any>[] = manifest["endpoints"] ?? [];
  const unverified = endpoints.filter((ep) => !ep["path_verified"]).map((ep) => ep["id"]);
  const age = ageDays(manifest["last_verified_against_docs_at"]);
  const messages: string[] = [];
  if (unverified.length > 0) {
    messages.push(`${unverified.length} endpoints path_verified=false: ${unverified.join(", ")}`);
  }
  if (age === null) {
    messages.push("last_verified_against_docs_at is missing or invalid");
  } else if (age > MAX_DOC_AGE_DAYS) {
    messages.push(`last_verified_against_docs_at is ${age} days old`);
  }
  if (messages.length > 0) {
    return ["stale", messages];
  }
  return ["fresh", [`${endpoints.length} endpoints verified`]];
}

function checkMetricSemantics(): [string, string[]] {
  const model = loadJson(resolveOutput(CONFIG.output.dataModel, ROOT));
  const stored = String(model["source_commit"] ?? "");
  const remote = originHead(APP_REPO);
  if (Object.keys(model).length === 0) {
    return ["stale", ["knowledge-store/data-model.json is missing"]];
  }
  if (stored === "unknown") {
    return ["unknown", ["data-model.json is still a placeholder"]];
  }
  if (remote && stored && !remote.startsWith(stored)) {
    return ["stale", [`source_commit ${stored} != origin HEAD ${remote}`]];
  }
  if (!remote) {
    return ["unknown", ["could not read app repo origin HEAD"]];
  }
  return ["fresh", [`source_commit ${stored} matches origin HEAD ${remote}`]];
}

const CHECKS: Record<string, () => [string, string[]]> = {
  "event-knowledge": checkEventKnowledge,
  "datafinder-interface": checkDatafinderInterface,
  "metric-semantics": checkMetricSemantics,
};

function main(argv: string[] | null = null): number {
  const args = argv !== null ? argv : process.argv.slice(2);
  if (args.length !== 1 || !(args[0]! in CHECKS)) {
    console.error("usage: check_freshness.js <event-knowledge|datafinder-interface|metric-semantics>");
    return 2;
  }
  const [status, messages] = CHECKS[args[0]!]!();
  // json.dumps default separators: ", " and ": ".
  console.log(
    `{"module": ${JSON.stringify(args[0])}, "status": ${JSON.stringify(status)}, `
    + `"messages": [${messages.map((m) => JSON.stringify(m)).join(", ")}]}`,
  );
  return status === "fresh" ? 0 : 1;
}

process.exit(main());
