#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const nextopDefault = resolve(repoRoot, "..", "nextop");
const outputFile = join(repoRoot, "knowledge-store", "event-catalog.json");

const tsReportersRelpath = "apps/desktop/src/renderer/src/features/analytics/reporters";
const goEventsRelpath = "services/nextopd/service/reporter/events";
const mainAnalyticsRelpath = "apps/desktop/src/main";

interface EventEntry {
  event_name: string;
  params: string[];
  trigger_files: string[];
}

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

function isTestFile(rel: string): boolean {
  return rel.includes(".test.") || rel.includes(".spec.") || rel.includes("__tests__");
}

function walkFiles(root: string, predicate: (path: string) => boolean): string[] {
  if (!existsSync(root)) return [];
  const output: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["node_modules", "dist", ".next", "out", ".git"].includes(entry.name)) stack.push(path);
      } else if (predicate(path)) {
        output.push(path);
      }
    }
  }
  return output;
}

function buildSymbolIndex(nextop: string, scopeDirs: string[], extensions: string[], pattern: string): Record<string, string[]> {
  const dirs = scopeDirs.map((dir) => join(nextop, dir)).filter(existsSync);
  if (dirs.length === 0) return {};
  const includeArgs = extensions.map((ext) => `--include=${ext}`);
  const result = spawnSync("grep", [
    "-rEo",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "--exclude-dir=.next",
    "--exclude-dir=out",
    "--exclude-dir=.git",
    ...includeArgs,
    pattern,
    ...dirs
  ], { encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0 && !result.stdout) return {};

  const index: Record<string, Set<string>> = {};
  for (const line of result.stdout.split(/\r?\n/)) {
    const split = line.lastIndexOf(":");
    if (split === -1) continue;
    const path = line.slice(0, split);
    const match = line.slice(split + 1);
    const rel = relative(nextop, path);
    if (!match || isTestFile(rel)) continue;
    index[match] ??= new Set();
    index[match].add(rel);
  }
  return Object.fromEntries(Object.entries(index).map(([key, value]) => [key, [...value].sort()]));
}

function tsEventName(file: string): string | undefined {
  return readFileSync(file, "utf8").match(/(?:protected|private)\s+readonly\s+eventName\s*=\s*["']([^"']+)["']/)?.[1];
}

function tsParams(file: string): string[] {
  if (!existsSync(file)) return [];
  const match = readFileSync(file, "utf8").match(/interface\s+\w+Params\s+extends\s+\w+[^{]*\{([^}]+)\}/s);
  return match ? [...match[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((item) => item[1]) : [];
}

function tsClassName(file: string): string | undefined {
  return readFileSync(file, "utf8").match(/export class (\w+)/)?.[1];
}

function extractTsReporters(nextop: string): EventEntry[] {
  const reportersDir = join(nextop, tsReportersRelpath);
  if (!existsSync(reportersDir)) return [];
  const symbolIndex = buildSymbolIndex(nextop, ["apps", "packages"], ["*.ts", "*.tsx"], "\\b[A-Z][A-Za-z0-9]*Reporter\\b");
  const events: EventEntry[] = [];
  for (const entry of readdirSync(reportersDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const reporterDir = join(reportersDir, entry.name);
    const candidates = readdirSync(reporterDir)
      .filter((name) => name.endsWith(".ts") && !["index.ts", "types.ts"].includes(name) && !name.includes(".test.") && !name.includes(".spec."))
      .map((name) => join(reporterDir, name));
    const reporterFile = candidates[0];
    if (!reporterFile) continue;
    const eventName = tsEventName(reporterFile);
    if (!eventName) continue;
    const className = tsClassName(reporterFile);
    events.push({
      event_name: eventName,
      params: tsParams(join(reporterDir, "types.ts")),
      trigger_files: (symbolIndex[className ?? ""] ?? []).filter((file) => !file.includes("analytics/reporters"))
    });
  }
  return events;
}

function extractGoEvents(nextop: string): EventEntry[] {
  const eventsDir = join(nextop, goEventsRelpath);
  if (!existsSync(eventsDir)) return [];
  const pathIndex = buildSymbolIndex(nextop, ["services", "packages", "apps"], ["*.go"], "reporter/events/[a-zA-Z0-9_/]+");
  return walkFiles(eventsDir, (path) => basename(path) === "event.go").flatMap((eventGo) => {
    const eventName = readFileSync(eventGo, "utf8").match(/reporterevents\.Track\([^,]+,\s*[^,]+,\s*"([^"]+)"/)?.[1];
    if (!eventName) return [];
    const pkgRel = relative(eventsDir, dirname(eventGo)).replaceAll("\\", "/");
    const importTail = `reporter/events/${pkgRel}`;
    return [{
      event_name: eventName,
      params: [],
      trigger_files: (pathIndex[importTail] ?? []).filter((file) => !file.endsWith("event.go"))
    }];
  });
}

function extractMainProcessEvents(nextop: string): EventEntry[] {
  const mainDir = join(nextop, mainAnalyticsRelpath);
  return walkFiles(mainDir, (path) => basename(path).endsWith("Analytics.ts")).flatMap((file) => {
    const names = [...readFileSync(file, "utf8").matchAll(/\bname:\s*["']([a-z][a-z0-9_.]+[a-z0-9])["']/g)].map((item) => item[1]);
    const rel = relative(nextop, file);
    return [...new Set(names)].map((name) => ({ event_name: name, params: [], trigger_files: [rel] }));
  });
}

function mergeEvents(sources: Array<[string, EventEntry[]]>): EventEntry[] {
  const merged = new Map<string, EventEntry>();
  for (const [, events] of sources) {
    for (const event of events) {
      const entry = merged.get(event.event_name) ?? { event_name: event.event_name, params: [], trigger_files: [] };
      if (event.params.length > 0 && entry.params.length === 0) entry.params = event.params;
      for (const file of event.trigger_files) {
        if (!entry.trigger_files.includes(file)) entry.trigger_files.push(file);
      }
      entry.trigger_files.sort();
      merged.set(event.event_name, entry);
    }
  }
  return [...merged.values()].sort((a, b) => a.event_name.localeCompare(b.event_name));
}

function main(argv = process.argv.slice(2)): number {
  const nextop = nextopRoot(argValue(argv, "--nextop-path"));
  if (!existsSync(nextop)) {
    console.error(`ERROR: nextop repo not found at ${nextop}`);
    console.error("Run domains/event-knowledge/sync_nextop.sh first, or set NEXTOP_REPO_PATH.");
    return 1;
  }

  console.log(`Scanning: ${nextop}`);
  const tsEvents = extractTsReporters(nextop);
  const goEvents = extractGoEvents(nextop);
  const mainEvents = extractMainProcessEvents(nextop);
  const allEvents = mergeEvents([["ts", tsEvents], ["go", goEvents], ["main", mainEvents]]);
  mkdirSync(dirname(outputFile), { recursive: true });
  writeFileSync(outputFile, JSON.stringify({
    generated_at: new Date().toISOString(),
    nextop_commit: gitCommit(nextop),
    nextop_path: nextop,
    total_events: allEvents.length,
    events: allEvents
  }, null, 2) + "\n", "utf8");
  console.log(`  TypeScript reporters : ${tsEvents.length}`);
  console.log(`  Go events            : ${goEvents.length}`);
  console.log(`  Main-process events  : ${mainEvents.length}`);
  console.log(`\nWrote ${allEvents.length} events -> ${outputFile}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
