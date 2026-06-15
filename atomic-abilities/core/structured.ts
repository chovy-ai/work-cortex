/**
 * runStructured · 通用原语：给一段 prompt + 一个 output JSON Schema，
 * 经 ACP 调 agent 得到「保证合 schema」的 JSON（解析 → 校验 → revise → 仍不合抛 AbilityOutputError）。
 *
 * 与 defineDeclarativeAbility 的区别：声明式能力把 prompt/schema/agent 写死在能力目录里；
 * runStructured 把它们放到调用期传入——给「prompt 与 schema 归属在自己领域」的消费方用
 * （如查询执行域的 understand：QueryIntent 的协议与 schema 都在 intent-routing，不该复制进本库）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { openBackendSession, type BackendDecl } from "./backend.js";
import { AbilityOutputError, AbilityRuntimeError } from "./errors.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..");
const BACKENDS_DIR = join(PKG_ROOT, "backends");

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);

export interface RunStructuredOpts {
  prompt: string; // 完整提示词（领域自己拼好的）
  outputSchema: object; // 产出 JSON Schema，强制校验
  agent?: string; // backend id，默认 claude
  reviseMax?: number; // 不合 schema 时重 prompt 上限，默认 1
  signal?: AbortSignal;
  timeoutMs?: number; // 默认 120s
}

function loadBackend(id: string): BackendDecl {
  try {
    return JSON.parse(readFileSync(join(BACKENDS_DIR, `${id}.json`), "utf8")) as BackendDecl;
  } catch (err) {
    throw new AbilityRuntimeError(`backend 声明缺失或不可读：${id}（${String(err)}）`);
  }
}

export async function runStructured<Out = unknown>(opts: RunStructuredOpts): Promise<Out> {
  const validate = ajv.compile(opts.outputSchema);
  const schemaJson = JSON.stringify(opts.outputSchema, null, 2);
  const reviseMax = opts.reviseMax ?? 1;
  const backend = loadBackend(opts.agent ?? "claude");

  const ac = new AbortController();
  const onParentAbort = (): void => ac.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort();
    else opts.signal.addEventListener("abort", onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 120_000);

  const session = await openBackendSession(backend, { pkgRoot: PKG_ROOT, repoRoot: REPO_ROOT, signal: ac.signal }).catch(
    (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onParentAbort);
      throw err;
    },
  );

  try {
    let prompt = composePrompt(opts.prompt, schemaJson);
    let lastViolation = "";
    for (let attempt = 0; attempt <= reviseMax; attempt++) {
      if (attempt > 0) prompt = revisePrompt(schemaJson, lastViolation);
      const raw = await session.prompt(prompt);
      const parsed = tryParseJson(raw);
      if (parsed === undefined) {
        lastViolation = "返回的不是合法 JSON";
        continue;
      }
      if (!validate(parsed)) {
        lastViolation = ajv.errorsText(validate.errors, { separator: "; " });
        continue;
      }
      return parsed as Out;
    }
    throw new AbilityOutputError(`runStructured 产出始终不合 schema（重试 ${reviseMax} 次后）：${lastViolation}`);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onParentAbort);
    session.close();
  }
}

function composePrompt(body: string, schemaJson: string): string {
  return [
    body,
    "",
    "[输出要求]",
    "你的最终回复必须且仅是一个 JSON 值，不要 markdown 代码块标记、不要任何解释或前后缀文字。",
    "严格匹配以下 JSON Schema：",
    schemaJson,
  ].join("\n");
}

function revisePrompt(schemaJson: string, violation: string): string {
  return [
    `上一次产出不合要求：${violation}。`,
    "请只重新输出一个合法 JSON 值（无代码块标记、无解释），严格匹配以下 schema：",
    schemaJson,
  ].join("\n");
}

function tryParseJson(raw: string): unknown {
  let s = raw.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    /* 退回片段抓取 */
  }
  const m = s.match(/[{[][\s\S]*[}\]]/);
  if (m) {
    try {
      return JSON.parse(m[0]);
    } catch {
      /* ignore */
    }
  }
  return undefined;
}
