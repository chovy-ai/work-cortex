#!/usr/bin/env node
/** Check that DataFinder manifest endpoint capabilities are represented. */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve to an absolute, symlink-free path (Python Path.resolve equivalent). */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

// Compiled file lives at build/domains/knowledge-update/check_capabilities_sync.js;
// repo root is 3 levels above its directory (one more than the .py original).
const ROOT = path.resolve(path.dirname(resolvePath(fileURLToPath(import.meta.url))), "..", "..", "..");
// manifest 已抽离到独立包 @workcortex/datafinder-sdk（单一真源），跨包引用其 manifest。
const MANIFEST = path.join(ROOT, "..", "..", "packages", "datafinder-sdk", "manifest.json");
const CAPABILITIES = path.join(ROOT, "domains", "intent-routing", "capabilities.json");

function load(p: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function main(): number {
  const manifest = load(MANIFEST);
  const capabilities = load(CAPABILITIES);
  const manifestIds = new Set<string>(
    ((manifest["endpoints"] ?? []) as Record<string, any>[])
      .filter((ep) => ep["capability_id"])
      .map((ep) => ep["capability_id"] as string),
  );
  const capabilityIds = new Set<string>(
    ((capabilities["capabilities"] ?? []) as Record<string, any>[])
      .filter((item) => ((item["capability_id"] ?? "") as string).startsWith("datafinder.openapi."))
      .map((item) => item["capability_id"] as string),
  );

  const missing = Array.from(manifestIds).filter((id) => !capabilityIds.has(id)).sort();
  const extra = Array.from(capabilityIds).filter((id) => !manifestIds.has(id)).sort();

  if (missing.length > 0 || extra.length > 0) {
    console.log("capabilities sync: stale");
    if (missing.length > 0) {
      console.log("missing in capabilities.json:");
      for (const item of missing) {
        console.log(`  - ${item}`);
      }
    }
    if (extra.length > 0) {
      console.log("not backed by manifest.json:");
      for (const item of extra) {
        console.log(`  - ${item}`);
      }
    }
    return 1;
  }

  console.log(`capabilities sync: ok (${manifestIds.size} OpenAPI capabilities)`);
  return 0;
}

process.exit(main());
