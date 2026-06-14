#!/usr/bin/env node
/**
 * DataFinder OpenAPI module CLI — discovery and ad-hoc calls.
 *
 * Discovery (no credentials needed):
 *     node build/domains/datafinder-interface/cli.js list
 *     node build/domains/datafinder-interface/cli.js describe report.query
 *
 * Invocation (reads .env.local for credentials):
 *     node build/domains/datafinder-interface/cli.js call dashboard.list
 *     node build/domains/datafinder-interface/cli.js call report.query --params '{"report_id":"123","period":{"start_time":"2026-06-01","end_time":"2026-06-07"}}'
 */

import { DataFinderClient, EndpointNotFound, loadConfigFromEnv, loadManifest } from "./client.js";

function cmdList(): number {
  const manifest = loadManifest();
  process.stdout.write(
    `DataFinder OpenAPI — ${manifest.endpoints.length} endpoints ` +
      `(doc root: ${manifest.global?.doc_root})\n\n`,
  );
  for (const ep of manifest.endpoints) {
    const flag = ep.path_verified ? "" : "  [path UNVERIFIED]";
    process.stdout.write(`  ${ep.id.padEnd(22)} ${ep.summary ?? ""}${flag}\n`);
  }
  return 0;
}

function cmdDescribe(endpointId: string): number {
  const manifest = loadManifest();
  const ep = manifest.endpoints.find((e) => e.id === endpointId);
  if (!ep) {
    const known = manifest.endpoints.map((e) => e.id).sort().join(", ");
    process.stderr.write(`Unknown endpoint '${endpointId}'.\n`);
    process.stderr.write(`Known: ${known}\n`);
    process.stderr.write(`To add it, see UPDATE.md and the docs: ${manifest.global?.doc_root}\n`);
    return 1;
  }
  process.stdout.write(JSON.stringify(ep, null, 2) + "\n");
  return 0;
}

async function cmdCall(endpointId: string, paramsJson?: string, envPath?: string): Promise<number> {
  const params = paramsJson ? (JSON.parse(paramsJson) as Record<string, unknown>) : {};
  const config = loadConfigFromEnv(envPath);
  const client = new DataFinderClient(config);
  let result;
  try {
    result = await client.call(endpointId, params);
  } catch (exc) {
    if (exc instanceof EndpointNotFound) {
      process.stderr.write(String(exc.message) + "\n");
      return 1;
    }
    throw exc;
  }
  process.stdout.write(
    JSON.stringify(
      {
        status: result.status,
        endpoint_id: result.endpoint_id,
        http_status: result.http_status ?? null,
        error_code: result.error_code ?? null,
        error_message: result.error_message ?? null,
        warnings: result.warnings,
        data: result.data ?? null,
      },
      null,
      2,
    ) + "\n",
  );
  return result.status === "success" ? 0 : 2;
}

function usage(): never {
  process.stderr.write(
    "usage: datafinder cli {list,describe,call}\n" +
      "  list                                  List all declared endpoints\n" +
      "  describe <endpoint_id>                Show one endpoint's full interface spec\n" +
      "  call <endpoint_id> [--params JSON] [--env PATH]\n",
  );
  process.exit(2);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "list") return cmdList();
  if (command === "describe") {
    if (!argv[1]) usage();
    return cmdDescribe(argv[1]);
  }
  if (command === "call") {
    const endpointId = argv[1];
    if (!endpointId) usage();
    let params: string | undefined;
    let env: string | undefined;
    for (let i = 2; i < argv.length; i++) {
      if (argv[i] === "--params") params = argv[++i];
      else if (argv[i] === "--env") env = argv[++i];
      else {
        process.stderr.write(`datafinder cli: error: unrecognized arguments: ${argv[i]}\n`);
        return 2;
      }
    }
    return cmdCall(endpointId, params, env);
  }
  usage();
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(String(err?.stack ?? err) + "\n");
    process.exit(1);
  },
);
