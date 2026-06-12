import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";

// 运行位置是 dist/core/，schema 真相源在包根 core/ 下
const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function loadSchema(name: string): object {
  return JSON.parse(readFileSync(join(pkgRoot, "core", name), "utf8"));
}

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);

const validators: Record<string, ValidateFunction> = {
  envelope: ajv.compile(loadSchema("envelope.schema.json")),
  task: ajv.compile(loadSchema("task.schema.json")),
  taskEvent: ajv.compile(loadSchema("task-event.schema.json")),
};

export type ContractName = "envelope" | "task" | "taskEvent";

export class ContractViolation extends Error {
  constructor(
    public contract: ContractName,
    public details: string,
  ) {
    super(`contract violation [${contract}]: ${details}`);
  }
}

export function isValid(contract: ContractName, data: unknown): boolean {
  return validators[contract](data) as boolean;
}

export function violationDetails(contract: ContractName): string {
  return ajv.errorsText(validators[contract].errors, { separator: "; " });
}

/** 校验失败抛 ContractViolation（含 ajv 错误详情）。每道接缝两端各验一次。 */
export function assertValid(contract: ContractName, data: unknown): void {
  if (!validators[contract](data)) {
    throw new ContractViolation(contract, violationDetails(contract));
  }
}
