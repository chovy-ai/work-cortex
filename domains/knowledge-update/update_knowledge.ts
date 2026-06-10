#!/usr/bin/env node
import { execSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const registry = join(root, "domains", "knowledge-update", "registry.json");

interface ModuleSpec {
  id: string;
  serves?: string[];
  update?: { type?: string; cmd?: string; procedure?: string };
  check?: { type?: string; cmd?: string };
  doc_links?: string[];
}

function discoverModules(): ModuleSpec[] {
  return readdirSync(join(root, "domains"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, "domains", entry.name, "module.json"))
    .filter((path) => {
      try {
        readFileSync(path);
        return true;
      } catch {
        return false;
      }
    })
    .sort()
    .map((path) => JSON.parse(readFileSync(path, "utf8")) as ModuleSpec);
}

function writeRegistry(modules: ModuleSpec[]): void {
  const payload = {
    modules: modules.map((module) => ({
      id: module.id,
      path: `domains/${module.id}/module.json`,
      serves: module.serves ?? []
    }))
  };
  writeFileSync(registry, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function runStatus(modules: ModuleSpec[]): number {
  let exitCode = 0;
  for (const module of modules) {
    const check = module.check ?? {};
    if (check.type !== "script" || !check.cmd) {
      console.log(`${module.id}: unknown (no script check)`);
      exitCode = 1;
      continue;
    }
    const result = spawnSync(check.cmd, { cwd: root, shell: true, encoding: "utf8" });
    const line = (result.stdout || result.stderr).trim();
    let status = "unknown";
    let messages = line;
    try {
      const payload = JSON.parse(line);
      status = payload.status ?? "unknown";
      messages = (payload.messages ?? []).join("; ");
    } catch {
      status = "unknown";
    }
    console.log(`${module.id}: ${status}${messages ? ` - ${messages}` : ""}`);
    if (status !== "fresh") exitCode = 1;
  }
  return exitCode;
}

function runUpdate(modules: ModuleSpec[], target: string): number {
  const selected = target === "all" ? modules : modules.filter((module) => module.id === target);
  if (selected.length === 0) {
    console.error(`unknown module: ${target}`);
    return 2;
  }
  let exitCode = 0;
  for (const module of selected) {
    const update = module.update ?? {};
    if (update.type === "script" && update.cmd) {
      try {
        execSync(update.cmd, { cwd: root, stdio: "inherit", shell: "/bin/sh" });
      } catch (error: any) {
        exitCode = error.status ?? 1;
      }
    } else if (update.type === "agent") {
      console.log(`${module.id}: agent update required`);
      console.log(`procedure: ${update.procedure}`);
      if ((module.doc_links ?? []).length > 0) {
        console.log("doc_links:");
        for (const link of module.doc_links ?? []) console.log(`  - ${link}`);
      }
    } else {
      console.error(`${module.id}: unknown update type`);
      exitCode = 1;
    }
  }
  return exitCode;
}

function main(argv = process.argv.slice(2)): number {
  const [command, target] = argv;
  const modules = discoverModules();
  if (command === "register") {
    writeRegistry(modules);
    console.log(`registered ${modules.length} modules`);
    return 0;
  }
  if (command === "status") return runStatus(modules);
  if (command === "update" && target) return runUpdate(modules, target);
  console.error("usage: update_knowledge.ts <status|register|update id|update all>");
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main();
}
