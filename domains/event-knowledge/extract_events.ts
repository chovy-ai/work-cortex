#!/usr/bin/env node
/**
 * Extract nextop analytics event catalog from source code.
 *
 * Reads the nextop monorepo to produce a structured event catalog with:
 *   - event_name   : DataFinder event identifier  (e.g. "agent.message_sent")
 *   - params       : list of camelCase param names from the TypeScript interface
 *   - trigger_files: files that instantiate / call this reporter (上报时机 context)
 *
 * Output: knowledge-store/event-catalog.json
 *
 * Usage:
 *     node build/domains/event-knowledge/extract_events.js [--nextop-path PATH]
 *     NEXTOP_REPO_PATH=/path/to/nextop node build/domains/event-knowledge/extract_events.js
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Resolve a path to an absolute, symlink-free form (Python Path.resolve equivalent). */
function resolvePath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Python Path.expanduser equivalent for "~" / "~/..." prefixes. */
function expandUser(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

const HERE = resolvePath(path.dirname(fileURLToPath(import.meta.url)));
// Compiled file lives at build/domains/event-knowledge/extract_events.js,
// one level deeper than the .py original, so each candidate gains one "..".
let REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..");
if (path.basename(REPO_ROOT) !== "data-analysis") {
  REPO_ROOT = path.resolve(HERE, "..", "..", "..");
}
const NEXTOP_DEFAULT = resolvePath(path.join(path.dirname(REPO_ROOT), "nextop"));
const OUTPUT_FILE = path.join(REPO_ROOT, "knowledge-store", "event-catalog.json");

const TS_REPORTERS_RELPATH = "apps/desktop/src/renderer/src/features/analytics/reporters";
const GO_EVENTS_RELPATH = "services/nextopd/service/reporter/events";
const MAIN_ANALYTICS_RELPATH = "apps/desktop/src/main";

interface EventEntry {
  event_name: string;
  params: string[];
  trigger_files: string[];
}

// ── helpers ────────────────────────────────────────────────────────────────────

function nextopRoot(override: string | null = null): string {
  if (override) {
    return resolvePath(expandUser(override));
  }
  const env = process.env["NEXTOP_REPO_PATH"];
  if (env) {
    return resolvePath(expandUser(env));
  }
  return NEXTOP_DEFAULT;
}

function gitCommit(repo: string): string {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.error) {
      return "unknown";
    }
    return (r.stdout ?? "").trim();
  } catch {
    return "unknown";
  }
}

const TRAVERSE_EXCLUDE = [
  "--exclude-dir=node_modules", "--exclude-dir=dist",
  "--exclude-dir=.next", "--exclude-dir=out", "--exclude-dir=.git",
];

function isTestFile(rel: string): boolean {
  return rel.includes(".test.") || rel.includes(".spec.") || rel.includes("__tests__");
}

/**
 * Single-pass reverse index: scan scoped source dirs ONCE with one grep and
 * map every matched symbol → the relative files that contain it.
 *
 * This replaces O(events) full-repo greps with O(1) greps per language,
 * which is the difference between ~10 minutes and a few seconds on a large repo.
 */
function buildSymbolIndex(
  nextop: string,
  scopeDirs: string[],
  extensions: string[],
  pattern: string,
): Map<string, string[]> {
  const includeArgs = extensions.map((ext) => `--include=${ext}`);
  const dirs = scopeDirs
    .map((d) => path.join(nextop, d))
    .filter((d) => fs.existsSync(d));
  if (dirs.length === 0) {
    return new Map();
  }

  const index = new Map<string, Set<string>>();
  let stdout: string;
  try {
    // -r recursive, -E extended regex, -o print only the matched symbol.
    // With -r and -o, each line is "<path>:<match>".
    const r = spawnSync(
      "grep",
      ["-rEo", ...TRAVERSE_EXCLUDE, ...includeArgs, pattern, ...dirs],
      { encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024 * 1024 },
    );
    if (r.error) {
      return new Map();
    }
    stdout = r.stdout ?? "";
  } catch {
    return new Map();
  }

  const prefix = nextop + "/";
  for (const line of stdout.split("\n")) {
    // Split on the LAST ':' — paths contain no ':' on this platform,
    // so "<path>:<match>" splits cleanly.
    const sep = line.lastIndexOf(":");
    const filePath = sep === -1 ? "" : line.slice(0, sep);
    const match = sep === -1 ? "" : line.slice(sep + 1);
    if (!filePath || !match) {
      continue;
    }
    const rel = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
    if (isTestFile(rel)) {
      continue;
    }
    let bucket = index.get(match);
    if (!bucket) {
      bucket = new Set();
      index.set(match, bucket);
    }
    bucket.add(rel);
  }

  const result = new Map<string, string[]>();
  for (const [k, v] of index) {
    result.set(k, Array.from(v).sort());
  }
  return result;
}

// ── TypeScript reporter extraction ─────────────────────────────────────────────

function tsEventName(reporterFile: string): string | null {
  const content = fs.readFileSync(reporterFile, "utf-8");
  const m = content.match(
    /(?:protected|private)\s+readonly\s+eventName\s*=\s*["']([^"']+)["']/,
  );
  return m ? m[1]! : null;
}

function tsParams(typesFile: string): string[] {
  if (!fs.existsSync(typesFile)) {
    return [];
  }
  const content = fs.readFileSync(typesFile, "utf-8");
  const m = content.match(/interface\s+\w+Params\s+extends\s+\w+[^{]*\{([^}]+)\}/s);
  if (!m) {
    return [];
  }
  return Array.from(m[1]!.matchAll(/^\s{2}(\w+)\??:/gm), (mm) => mm[1]!);
}

function tsClassName(reporterFile: string): string | null {
  const content = fs.readFileSync(reporterFile, "utf-8");
  const m = content.match(/export class (\w+)/);
  return m ? m[1]! : null;
}

function extractTsReporters(nextop: string): EventEntry[] {
  const reportersDir = path.join(nextop, TS_REPORTERS_RELPATH);
  if (!fs.existsSync(reportersDir)) {
    return [];
  }

  // ONE grep over apps+packages for every "...Reporter" symbol occurrence.
  const symbolIndex = buildSymbolIndex(
    nextop,
    ["apps", "packages"],
    ["*.ts", "*.tsx"],
    "\\b[A-Z][A-Za-z0-9]*Reporter\\b",
  );

  const events: EventEntry[] = [];
  for (const entryName of fs.readdirSync(reportersDir).sort()) {
    const reporterDir = path.join(reportersDir, entryName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(reporterDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) {
      continue;
    }

    // Main reporter file: not index.ts, not types.ts, not a test
    const candidates = fs.readdirSync(reporterDir).sort()
      .filter((name) =>
        name.endsWith(".ts")
        && name !== "index.ts" && name !== "types.ts"
        && !name.includes(".test.")
        && !name.includes(".spec."),
      );
    if (candidates.length === 0) {
      continue;
    }
    const reporterFile = path.join(reporterDir, candidates[0]!);

    const eventName = tsEventName(reporterFile);
    if (!eventName) {
      continue;
    }

    const params = tsParams(path.join(reporterDir, "types.ts"));
    const className = tsClassName(reporterFile);

    // Trigger files = usages of the reporter class, minus the reporters/
    // definition tree itself (its own file, index re-exports, etc.).
    const triggerFiles = (symbolIndex.get(className ?? "") ?? [])
      .filter((f) => !f.includes("analytics/reporters"));

    events.push({
      event_name: eventName,
      params,
      trigger_files: triggerFiles,
    });
  }

  return events;
}

// ── Go event extraction ────────────────────────────────────────────────────────

/** Recursively collect files with the given basename (Python Path.rglob equivalent). */
function rglob(dir: string, basename: string): string[] {
  const results: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.name === basename) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results.sort();
}

function extractGoEvents(nextop: string): EventEntry[] {
  const eventsDir = path.join(nextop, GO_EVENTS_RELPATH);
  if (!fs.existsSync(eventsDir)) {
    return [];
  }

  // ONE grep for every reporter-event import path reference across .go files.
  // Callers import each event package by its full path, e.g.
  //   ".../reporter/events/agent/message_sent"
  // The tail after "reporter/events/" uniquely identifies the event package,
  // avoiding the basename collisions (e.g. multiple "opened") that a bare
  // package-name grep would hit.
  const pathIndex = buildSymbolIndex(
    nextop,
    ["services", "packages", "apps"],
    ["*.go"],
    "reporter/events/[a-zA-Z0-9_/]+",
  );

  const events: EventEntry[] = [];
  for (const eventGo of rglob(eventsDir, "event.go")) {
    const content = fs.readFileSync(eventGo, "utf-8");
    const m = content.match(/reporterevents\.Track\([^,]+,\s*[^,]+,\s*"([^"]+)"/);
    if (!m) {
      continue;
    }
    const eventName = m[1]!;

    // Package path tail relative to the events dir, e.g. "agent/message_sent".
    const pkgRel = path.relative(eventsDir, path.dirname(eventGo)).split(path.sep).join("/");
    const importTail = `reporter/events/${pkgRel}`;

    const triggerFiles = (pathIndex.get(importTail) ?? [])
      .filter((f) => !f.endsWith("event.go"));

    events.push({
      event_name: eventName,
      params: [],
      trigger_files: triggerFiles,
    });
  }

  return events;
}

// ── Main-process (Electron) event extraction ───────────────────────────────────

function extractMainProcessEvents(nextop: string): EventEntry[] {
  const mainDir = path.join(nextop, MAIN_ANALYTICS_RELPATH);
  if (!fs.existsSync(mainDir)) {
    return [];
  }

  const events: EventEntry[] = [];
  const analyticsFiles = fs.readdirSync(mainDir).sort()
    .filter((name) => name.endsWith("Analytics.ts"))
    .map((name) => path.join(mainDir, name));
  for (const analyticsFile of analyticsFiles) {
    const content = fs.readFileSync(analyticsFile, "utf-8");
    // name: "event.name" inside trackEvents / createXxxEvent calls
    const names = Array.from(
      content.matchAll(/\bname:\s*["']([a-z][a-z0-9_.]+[a-z0-9])["']/g),
      (m) => m[1]!,
    );
    const prefix = nextop + "/";
    const rel = analyticsFile.startsWith(prefix)
      ? analyticsFile.slice(prefix.length)
      : analyticsFile;
    for (const name of new Set(names)) {  // deduplicate, preserve order
      events.push({
        event_name: name,
        params: [],
        trigger_files: [rel],
      });
    }
  }

  return events;
}

// ── Main ───────────────────────────────────────────────────────────────────────

/** Python datetime.now(timezone.utc).isoformat() equivalent (millisecond precision). */
function isoNowUtc(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    + `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const micros = d.getUTCMilliseconds() * 1000;
  return micros === 0 ? `${base}+00:00` : `${base}.${pad(micros, 6)}+00:00`;
}

/** argparse equivalent for: --nextop-path PATH, -h/--help. */
function parseArgs(argv: string[]): { nextopPath: string | null } {
  const prog = path.basename(process.argv[1] ?? "extract_events.js");
  const usage = `usage: ${prog} [-h] [--nextop-path NEXTOP_PATH]`;
  let nextopPath: string | null = null;
  const extras: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-h" || arg === "--help") {
      console.log(
        `${usage}\n\nExtract nextop analytics event catalog\n\noptional arguments:\n`
        + `  -h, --help            show this help message and exit\n`
        + `  --nextop-path NEXTOP_PATH\n`
        + `                        Override path to nextop monorepo root`,
      );
      process.exit(0);
    } else if (arg === "--nextop-path") {
      if (i + 1 >= argv.length) {
        console.error(usage);
        console.error(`${prog}: error: argument --nextop-path: expected one argument`);
        process.exit(2);
      }
      nextopPath = argv[++i]!;
    } else if (arg.startsWith("--nextop-path=")) {
      nextopPath = arg.slice("--nextop-path=".length);
    } else {
      extras.push(arg);
    }
  }
  if (extras.length > 0) {
    console.error(usage);
    console.error(`${prog}: error: unrecognized arguments: ${extras.join(" ")}`);
    process.exit(2);
  }
  return { nextopPath };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  const nextop = nextopRoot(args.nextopPath);
  if (!fs.existsSync(nextop)) {
    console.error(
      `ERROR: nextop repo not found at ${nextop}\n`
      + `Run domains/event-knowledge/sync_nextop.sh first, or set NEXTOP_REPO_PATH.`,
    );
    process.exit(1);
  }

  console.log(`Scanning: ${nextop}`);

  const tsEvents = extractTsReporters(nextop);
  const goEvents = extractGoEvents(nextop);
  const mainEvents = extractMainProcessEvents(nextop);

  // Merge all three sources by event_name. An event may surface in more than
  // one source (a TS reporter, a Go mirror, a main-process call site); union
  // their trigger files and keep the richest param list so 上报时机 from the
  // main process is not lost just because a same-named TS reporter exists.
  const merged = new Map<string, EventEntry>();
  let nGoOnly = 0;
  let nMainOnly = 0;
  const sources: Array<[string, EventEntry[]]> = [
    ["ts", tsEvents], ["go", goEvents], ["main", mainEvents],
  ];
  for (const [source, events] of sources) {
    for (const e of events) {
      const name = e.event_name;
      if (!merged.has(name)) {
        merged.set(name, { event_name: name, params: [], trigger_files: [] });
        if (source === "go") {
          nGoOnly += 1;
        } else if (source === "main") {
          nMainOnly += 1;
        }
      }
      const entry = merged.get(name)!;
      if (e.params.length > 0 && entry.params.length === 0) {
        entry.params = e.params;
      }
      for (const f of e.trigger_files) {
        if (!entry.trigger_files.includes(f)) {
          entry.trigger_files.push(f);
        }
      }
    }
  }
  const nTs = tsEvents.length;

  for (const entry of merged.values()) {
    entry.trigger_files.sort();
  }

  const allEvents = Array.from(merged.values()).sort((a, b) =>
    a.event_name < b.event_name ? -1 : a.event_name > b.event_name ? 1 : 0,
  );
  console.log(`  TypeScript reporters : ${nTs}`);
  console.log(`  Go-only events       : ${nGoOnly}`);
  console.log(`  Main-process-only    : ${nMainOnly}`);

  const catalog = {
    generated_at: isoNowUtc(),
    nextop_commit: gitCommit(nextop),
    nextop_path: nextop,
    total_events: allEvents.length,
    events: allEvents,
  };

  fs.mkdirSync(path.dirname(OUTPUT_FILE), { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2) + "\n", "utf-8");
  console.log(`\nWrote ${allEvents.length} events → ${OUTPUT_FILE}`);
  console.log("\nSample (first 5):");
  for (const e of allEvents.slice(0, 5)) {
    const triggers = e.trigger_files.slice(0, 1);
    console.log(`  ${e.event_name}`);
    if (e.params.length > 0) {
      console.log(`    params       : ${e.params.join(", ")}`);
    }
    if (triggers.length > 0) {
      console.log(`    triggered at : ${triggers[0]}`);
    }
  }
}

main();
