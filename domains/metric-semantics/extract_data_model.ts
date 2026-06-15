#!/usr/bin/env node
/** Extract the target application's analytics data model facts into knowledge-store. */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dataAnalysisRoot, loadAppConfig, resolveOutput, resolveTargetRepo } from "../app-config/config.js";

const DESCRIPTION = "Extract the target application's analytics data model facts into knowledge-store.";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dataAnalysisRoot(HERE);
const CONFIG = loadAppConfig(REPO_ROOT);
const OUTPUT_FILE = resolveOutput(CONFIG.output.dataModel, REPO_ROOT);

const DEFAULTS_RELPATH = CONFIG.sources.dataModel.defaults;
const REPORTER_RELPATH = CONFIG.sources.dataModel.reporter;
const TRACKING_DOC_RELPATH = CONFIG.sources.dataModel.trackingDoc;

function appRepoRoot(override: string | null = null): string {
  return resolveTargetRepo(override, REPO_ROOT);
}

function gitCommit(repo: string): string {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  return result.status === 0 ? (result.stdout ?? "").trim() : "unknown";
}

function loadDefaults(appRepo: string): Record<string, any> {
  const p = path.join(appRepo, DEFAULTS_RELPATH);
  if (!fs.existsSync(p)) {
    return {};
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  const analytics = raw["analytics"] ?? {};
  // `?? null` keeps missing keys serialized as JSON null, like Python's None.
  return {
    appId: analytics["appId"] ?? null,
    appName: analytics["appName"] ?? null,
    channel: analytics["channel"] ?? null,
    channelDomain: analytics["channelDomain"] ?? null,
    appVersion: analytics["appVersion"] ?? null,
    subjectId: analytics["subjectId"] ?? null,
    subjectName: analytics["subjectName"] ?? null,
  };
}

function extractGoStringList(pattern: RegExp, content: string): string[] {
  const match = content.match(pattern);
  if (!match) {
    return [];
  }
  return Array.from(match[1]!.matchAll(/"([^"]+)"/g), (m) => m[1]!);
}

function loadReporterSemantics(appRepo: string): [string[], string[]] {
  const p = path.join(appRepo, REPORTER_RELPATH);
  if (!fs.existsSync(p)) {
    return [[], []];
  }
  const content = fs.readFileSync(p, "utf-8");
  const common = extractGoStringList(/return\s+map\[string\]any\s*\{([^}]+)\}/s, content);
  const stripped = extractGoStringList(/for\s+_,\s+key\s*:=\s+range\s+\[\]string\s*\{([^}]+)\}/s, content);
  return [common, stripped];
}

/** Python str.strip(chars) equivalent: strip any of `chars` from both ends. */
function stripChars(s: string, chars: string): string {
  let start = 0;
  let end = s.length;
  while (start < end && chars.includes(s[start]!)) {
    start++;
  }
  while (end > start && chars.includes(s[end - 1]!)) {
    end--;
  }
  return s.slice(start, end);
}

function loadTrackingDoc(appRepo: string): Record<string, any> {
  const p = path.join(appRepo, TRACKING_DOC_RELPATH);
  if (!fs.existsSync(p)) {
    return { path: TRACKING_DOC_RELPATH, exists: false, summary: "" };
  }
  const text = fs.readFileSync(p, "utf-8");
  const headings = text.split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith("#"))
    .map((line) => stripChars(line, "# ").trim());
  return {
    path: TRACKING_DOC_RELPATH,
    exists: true,
    summary: headings.slice(0, 6).join(" / "),
  };
}

/** Python datetime.now(timezone.utc).isoformat() equivalent (millisecond precision). */
function isoNowUtc(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = d.getUTCMilliseconds() * 1000;
  return micros === 0 ? `${base}+00:00` : `${base}.${pad(micros, 6)}+00:00`;
}

function buildModel(appRepo: string): Record<string, any> {
  const [common, stripped] = loadReporterSemantics(appRepo);
  return {
    generated_at: isoNowUtc(),
    source_commit: gitCommit(appRepo),
    source_path: appRepo,
    defaults: loadDefaults(appRepo),
    default_metric_policy: {
      dau: {
        identity: "device_id",
        aggregation: "count(distinct device_id)",
        time_bucket: "local day",
        event_time_preference: "client_ts / local_time_ms",
      },
    },
    reporter_common_params: common,
    renderer_stripped_params: stripped,
    tracking_doc: loadTrackingDoc(appRepo),
    sources: {
      defaults: DEFAULTS_RELPATH,
      reporter: REPORTER_RELPATH,
      tracking_doc: TRACKING_DOC_RELPATH,
    },
  };
}

/** argparse equivalent for: --app-path PATH, -h/--help. */
function parseArgs(argv: string[]): { appPath: string | null } {
  const prog = path.basename(process.argv[1] ?? "extract_data_model.js");
  const usage = `usage: ${prog} [-h] [--app-path APP_PATH]`;
  let appPath: string | null = null;
  const extras: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(
        `${usage}\n\n${DESCRIPTION}\n\noptional arguments:\n`
        + `  -h, --help            show this help message and exit\n`
        + `  --app-path APP_PATH\n`
        + `                        Override path to the application monorepo root`,
      );
      process.exit(0);
    } else if (arg === "--app-path") {
      if (i + 1 >= argv.length) {
        console.error(usage);
        console.error(`${prog}: error: argument --app-path: expected one argument`);
        process.exit(2);
      }
      appPath = argv[++i]!;
    } else if (arg.startsWith("--app-path=")) {
      appPath = arg.slice("--app-path=".length);
    } else {
      extras.push(arg);
    }
  }
  if (extras.length > 0) {
    console.error(usage);
    console.error(`${prog}: error: unrecognized arguments: ${extras.join(" ")}`);
    process.exit(2);
  }
  return { appPath };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));

  const appRepo = appRepoRoot(args.appPath);
  if (!fs.existsSync(appRepo)) {
    console.error(`ERROR: application repo not found at ${appRepo}`);
    process.exit(1);
  }

  const model = buildModel(appRepo);
  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(model, null, 2) + "\n", "utf-8");
  console.log(`Wrote data model -> ${OUTPUT_FILE}`);
  return 0;
}

process.exit(main());
