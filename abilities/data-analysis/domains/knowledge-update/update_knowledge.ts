#!/usr/bin/env node
/** Control plane for data-analysis knowledge module updates. */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DESCRIPTION = "Control plane for data-analysis knowledge module updates.";

/** Resolve to an absolute, symlink-free path (Python Path.resolve equivalent). */
function resolvePath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

// Compiled file lives at build/domains/knowledge-update/update_knowledge.js;
// repo root is 3 levels above its directory (one more than the .py original).
const ROOT = path.resolve(path.dirname(resolvePath(fileURLToPath(import.meta.url))), "..", "..", "..");
const REGISTRY = path.join(ROOT, "domains", "knowledge-update", "registry.json");

type Module = Record<string, any>;

function discoverModules(): Module[] {
  const modules: Module[] = [];
  const domainsDir = path.join(ROOT, "domains");
  const modulePaths: string[] = [];
  for (const name of fs.readdirSync(domainsDir)) {
    const modulePath = path.join(domainsDir, name, "module.json");
    let stat: fs.Stats;
    try {
      stat = fs.statSync(modulePath);
    } catch {
      continue;
    }
    if (stat.isFile()) {
      modulePaths.push(modulePath);
    }
  }
  modulePaths.sort();
  for (const modulePath of modulePaths) {
    modules.push(JSON.parse(fs.readFileSync(modulePath, "utf-8")));
  }
  return modules;
}

function writeRegistry(modules: Module[]): void {
  const payload = {
    modules: modules.map((module) => ({
      id: module["id"],
      path: path.relative(ROOT, path.join(ROOT, "domains", module["id"], "module.json")),
      serves: module["serves"] ?? [],
    })),
  };
  fs.writeFileSync(REGISTRY, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function runStatus(modules: Module[]): number {
  let exitCode = 0;
  for (const module of modules) {
    const check = module["check"] ?? {};
    if (check["type"] !== "script" || !check["cmd"]) {
      console.log(`${module["id"]}: unknown (no script check)`);
      exitCode = 1;
      continue;
    }
    const result = spawnSync(check["cmd"], {
      cwd: ROOT,
      shell: true,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    const line = (result.stdout ?? "").trim() || (result.stderr ?? "").trim();
    let status: string;
    let messages: string;
    try {
      const payload = JSON.parse(line);
      status = payload["status"] ?? "unknown";
      messages = (payload["messages"] ?? []).join("; ");
    } catch {
      status = "unknown";
      messages = line;
    }
    console.log(`${module["id"]}: ${status}` + (messages ? ` - ${messages}` : ""));
    if (status !== "fresh") {
      exitCode = 1;
    }
  }
  return exitCode;
}

function runUpdate(modules: Module[], target: string): number {
  const selected = target === "all" ? modules : modules.filter((module) => module["id"] === target);
  if (selected.length === 0) {
    console.error(`unknown module: ${target}`);
    return 2;
  }

  let exitCode = 0;
  for (const module of selected) {
    const update = module["update"] ?? {};
    if (update["type"] === "script") {
      const result = spawnSync(update["cmd"], { cwd: ROOT, shell: true, stdio: "inherit" });
      const returncode = result.status ?? 1;
      if (returncode !== 0) {
        exitCode = returncode;
      }
    } else if (update["type"] === "agent") {
      console.log(`${module["id"]}: agent update required`);
      console.log(`procedure: ${update["procedure"] ?? "None"}`);
      const links: string[] = module["doc_links"] ?? [];
      if (links.length > 0) {
        console.log("doc_links:");
        for (const link of links) {
          console.log(`  - ${link}`);
        }
      }
    } else {
      console.error(`${module["id"]}: unknown update type`);
      exitCode = 1;
    }
  }
  return exitCode;
}

function main(argv: string[] | null = null): number {
  const args = argv ?? process.argv.slice(2);
  const prog = path.basename(process.argv[1] ?? "update_knowledge.js");
  const usage = `usage: ${prog} [-h] {status,update,register} ...`;
  const choices = ["status", "update", "register"];

  // argparse equivalent: required subcommand {status,update,register},
  // "update" takes one positional "target".
  const fail = (parserProg: string, parserUsage: string, message: string): never => {
    console.error(parserUsage);
    console.error(`${parserProg}: error: ${message}`);
    process.exit(2);
  };

  if (args.length > 0 && (args[0] === "-h" || args[0] === "--help")) {
    console.log(
      `${usage}\n\n${DESCRIPTION}\n\npositional arguments:\n`
      + `  {status,update,register}\n\noptional arguments:\n`
      + `  -h, --help            show this help message and exit`,
    );
    return 0;
  }
  if (args.length === 0) {
    fail(prog, usage, "the following arguments are required: command");
  }
  const command = args[0]!;
  if (!choices.includes(command)) {
    fail(prog, usage, `argument command: invalid choice: '${command}' (choose from 'status', 'update', 'register')`);
  }
  const rest = args.slice(1);

  let target: string | null = null;
  if (command === "update") {
    const subProg = `${prog} update`;
    const subUsage = `usage: ${subProg} [-h] target`;
    if (rest.length > 0 && (rest[0] === "-h" || rest[0] === "--help")) {
      console.log(
        `${subUsage}\n\npositional arguments:\n  target\n\noptional arguments:\n`
        + `  -h, --help  show this help message and exit`,
      );
      return 0;
    }
    if (rest.length === 0) {
      fail(subProg, subUsage, "the following arguments are required: target");
    }
    target = rest[0]!;
    if (rest.length > 1) {
      fail(prog, usage, `unrecognized arguments: ${rest.slice(1).join(" ")}`);
    }
  } else if (rest.length > 0) {
    fail(prog, usage, `unrecognized arguments: ${rest.join(" ")}`);
  }

  const modules = discoverModules();
  if (command === "register") {
    writeRegistry(modules);
    console.log(`registered ${modules.length} modules`);
    return 0;
  }
  if (command === "status") {
    return runStatus(modules);
  }
  if (command === "update") {
    return runUpdate(modules, target!);
  }
  return 2;
}

process.exit(main());
