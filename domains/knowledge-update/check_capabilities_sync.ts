#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

function main(): number {
  const manifest = readJson<any>("domains/datafinder-interface/manifest.json");
  const capabilities = readJson<any>("domains/intent-routing/capabilities.json");
  const manifestIds = new Set(
    manifest.endpoints
      .map((ep: any) => ep.capability_id)
      .filter(Boolean)
  );
  const capabilityIds = new Set(
    capabilities.capabilities
      .map((item: any) => item.capability_id)
      .filter((id: string) => id?.startsWith("datafinder.openapi."))
  );

  const missing = [...manifestIds].filter((id) => !capabilityIds.has(id)).sort();
  const extra = [...capabilityIds].filter((id) => !manifestIds.has(id)).sort();
  if (missing.length > 0 || extra.length > 0) {
    console.log("capabilities sync: stale");
    if (missing.length > 0) {
      console.log("missing in capabilities.json:");
      for (const item of missing) console.log(`  - ${item}`);
    }
    if (extra.length > 0) {
      console.log("not backed by manifest.json:");
      for (const item of extra) console.log(`  - ${item}`);
    }
    return 1;
  }

  console.log(`capabilities sync: ok (${manifestIds.size} OpenAPI capabilities)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
