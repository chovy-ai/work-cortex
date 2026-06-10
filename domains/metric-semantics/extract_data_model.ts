#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const nextopDefault = resolve(repoRoot, "..", "nextop");
const outputFile = join(repoRoot, "knowledge-store", "data-model.json");
const defaultsRelpath = "config/nextop.defaults.json";
const reporterRelpath = "services/nextopd/service/reporter/tea_reporter.go";
const trackingDocRelpath = "docs/architecture/analytics-tracking.md";

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function nextopRoot(override?: string): string {
  return resolve(override ?? process.env.NEXTOP_REPO_PATH ?? nextopDefault);
}

function gitCommit(repo: string): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    return "unknown";
  }
}

function loadDefaults(nextop: string): Record<string, unknown> {
  const path = join(nextop, defaultsRelpath);
  if (!existsSync(path)) return {};
  const analytics = JSON.parse(readFileSync(path, "utf8")).analytics ?? {};
  return {
    appId: analytics.appId,
    appName: analytics.appName,
    channel: analytics.channel,
    channelDomain: analytics.channelDomain,
    appVersion: analytics.appVersion,
    subjectId: analytics.subjectId,
    subjectName: analytics.subjectName
  };
}

function extractGoStringList(pattern: RegExp, content: string): string[] {
  const match = content.match(pattern);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]) : [];
}

function loadReporterSemantics(nextop: string): [string[], string[]] {
  const path = join(nextop, reporterRelpath);
  if (!existsSync(path)) return [[], []];
  const content = readFileSync(path, "utf8");
  const common = extractGoStringList(/return\s+map\[string\]any\s*\{([^}]+)\}/s, content);
  const stripped = extractGoStringList(/for\s+_,\s+key\s*:=\s+range\s+\[\]string\s*\{([^}]+)\}/s, content);
  return [common, stripped];
}

function loadTrackingDoc(nextop: string): Record<string, unknown> {
  const path = join(nextop, trackingDocRelpath);
  if (!existsSync(path)) return { path: trackingDocRelpath, exists: false, summary: "" };
  const headings = readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("#"))
    .map((line) => line.replace(/^#+\s*/, "").trim());
  return { path: trackingDocRelpath, exists: true, summary: headings.slice(0, 6).join(" / ") };
}

export function buildModel(nextop: string): Record<string, unknown> {
  const [common, stripped] = loadReporterSemantics(nextop);
  return {
    generated_at: new Date().toISOString(),
    nextop_commit: gitCommit(nextop),
    nextop_path: nextop,
    defaults: loadDefaults(nextop),
    default_metric_policy: {
      dau: {
        identity: "device_id",
        aggregation: "count(distinct device_id)",
        time_bucket: "local day",
        event_time_preference: "client_ts / local_time_ms"
      }
    },
    nextopd_common_params: common,
    renderer_stripped_params: stripped,
    tracking_doc: loadTrackingDoc(nextop),
    sources: {
      defaults: defaultsRelpath,
      reporter: reporterRelpath,
      tracking_doc: trackingDocRelpath
    }
  };
}

function main(argv = process.argv.slice(2)): number {
  const nextop = nextopRoot(argValue(argv, "--nextop-path"));
  if (!existsSync(nextop)) {
    console.error(`ERROR: nextop repo not found at ${nextop}`);
    return 1;
  }
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify(buildModel(nextop), null, 2) + "\n", "utf8");
  console.log(`Wrote data model -> ${outputFile}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
