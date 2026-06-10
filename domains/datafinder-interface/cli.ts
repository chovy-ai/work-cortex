#!/usr/bin/env node
import { DataFinderClient, loadConfigFromEnv, loadManifest } from "./client.ts";

function printUsage(): void {
  console.error("usage: tsx domains/datafinder-interface/cli.ts <list|describe|call> [endpoint_id] [--params JSON] [--env PATH]");
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  const [command, endpointId] = argv;
  const manifest = loadManifest();

  if (command === "list") {
    console.log(`DataFinder OpenAPI — ${manifest.endpoints.length} endpoints (doc root: ${manifest.global?.doc_root})\n`);
    for (const ep of manifest.endpoints) {
      const flag = ep.path_verified ? "" : "  [path UNVERIFIED]";
      console.log(`  ${ep.id.padEnd(22)} ${ep.summary ?? ""}${flag}`);
    }
    return 0;
  }

  if (command === "describe") {
    if (!endpointId) {
      printUsage();
      return 2;
    }
    const ep = manifest.endpoints.find((item) => item.id === endpointId);
    if (!ep) {
      console.error(`Unknown endpoint '${endpointId}'.`);
      console.error(`Known: ${manifest.endpoints.map((item) => item.id).sort().join(", ")}`);
      console.error(`To add it, see UPDATE.md and the docs: ${manifest.global?.doc_root}`);
      return 1;
    }
    console.log(JSON.stringify(ep, null, 2));
    return 0;
  }

  if (command === "call") {
    if (!endpointId) {
      printUsage();
      return 2;
    }
    const paramsRaw = argValue(argv, "--params");
    const envPath = argValue(argv, "--env");
    const params = paramsRaw ? JSON.parse(paramsRaw) : {};
    const client = new DataFinderClient(loadConfigFromEnv(envPath));
    const result = await client.call(endpointId, params);
    console.log(JSON.stringify(result, null, 2));
    return result.status === "success" ? 0 : 2;
  }

  printUsage();
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
