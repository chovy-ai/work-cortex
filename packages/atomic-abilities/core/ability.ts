import { mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ValidateFunction } from "ajv";
import { openBackendSession, type BackendDecl } from "./backend.js";
import { AbilityInputError, AbilityOutputError, AbilityRuntimeError } from "./errors.js";

export interface AbilityOpts {
  signal?: AbortSignal; // 取消
  timeoutMs?: number; // 覆盖默认预算
  workspace?: string; // 产物落盘目录（produces files 的能力用；不传则默认 outputs/<id>-<uuid>/）
}

export interface AbilityMeta {
  id: string;
  description: string;
}

/** 调用期上下文，传给输入准备 / 产出核验钩子。 */
export interface AbilityCtx {
  workspace: string; // 绝对路径；producesFiles 能力在开跑前已 mkdir
}

/** 对外的原子能力 = 一个带 meta 的 async 方法。 */
export type AbilityFn<In, Out> = ((input: In, opts?: AbilityOpts) => Promise<Out>) & {
  meta: AbilityMeta;
};

export interface DeclSpec<In, Out> {
  id: string;
  description: string;
  agent: string; // 绑定的 backend id（backends/<id>.json）
  dir: string; // 能力源码目录（绝对路径），放 prompt 模板与 io schema
  prompt?: string; // 文件名，默认 "prompt.md"
  ioSchema?: string; // 文件名，默认 "io.schema.json"，含 { input?, output }
  limits?: { timeoutMs?: number; reviseMax?: number };
  producesFiles?: boolean; // true：建 workspace、把其绝对路径注入 prompt、产出附 workspace 字段
  /** 渲染 prompt 前的输入处理（如把文件路径解析为绝对路径 + 校验存在）；可抛 AbilityInputError。 */
  prepareInput?: (input: In, ctx: AbilityCtx) => In | Promise<In>;
  /** 往 prompt 注入命名变量：prompt.md 里的 {{key}} 会被替换为对应值（如 {{scenarios}} 注入场景索引）。 */
  promptVars?: (input: In, ctx: AbilityCtx) => Record<string, string>;
  /** 过 output schema 之后的额外核验（如核对文件真落盘）；返回违约说明触发 revise，null 通过。 */
  verifyOutput?: (out: Out, ctx: AbilityCtx) => string | null;
}

// 运行位置 dist/core/ → 包根 atomic-abilities/ → 仓库根
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..");
const REPO_ROOT = resolve(PKG_ROOT, "..");
const BACKENDS_DIR = join(PKG_ROOT, "backends");

const ajv = new Ajv2020.default({ allErrors: true, strict: false });
addFormats.default(ajv);

function loadBackend(id: string): BackendDecl {
  try {
    return JSON.parse(readFileSync(join(BACKENDS_DIR, `${id}.json`), "utf8")) as BackendDecl;
  } catch (err) {
    throw new AbilityRuntimeError(`backend 声明缺失或不可读：${id}（${String(err)}）`);
  }
}

/**
 * 声明式能力的共享骨架（内部）：校验输入 →（产文件则建 workspace）→ prepareInput →
 * 拉 agent → prompt → 解析 → 校验产出（schema + 可选 verifyOutput）→ 不合即带 violation
 * revise（上限 reviseMax）→ 仍不合抛 AbilityOutputError。产出保证合法，绝不返回非法数据。
 */
export function defineDeclarativeAbility<In = unknown, Out = unknown>(spec: DeclSpec<In, Out>): AbilityFn<In, Out> {
  const promptFile = join(spec.dir, spec.prompt ?? "prompt.md");
  const schemaFile = join(spec.dir, spec.ioSchema ?? "io.schema.json");
  const reviseMax = spec.limits?.reviseMax ?? 1;
  const defaultTimeout = spec.limits?.timeoutMs ?? 120_000;

  let template: string | null = null;
  let outSchemaJson = "";
  let inValidate: ValidateFunction | null = null;
  let outValidate: ValidateFunction | null = null;

  const ensureLoaded = (): void => {
    if (template !== null) return;
    const schema = JSON.parse(readFileSync(schemaFile, "utf8")) as { input?: object; output: object };
    inValidate = schema.input ? ajv.compile(schema.input) : null;
    outValidate = ajv.compile(schema.output);
    outSchemaJson = JSON.stringify(schema.output, null, 2);
    template = readFileSync(promptFile, "utf8");
  };

  const fn = (async (input: In, opts: AbilityOpts = {}): Promise<Out> => {
    ensureLoaded();
    if (inValidate && !inValidate(input)) {
      throw new AbilityInputError(`${spec.id} 输入不合 schema：${ajv.errorsText(inValidate.errors, { separator: "; " })}`);
    }

    // workspace（仅 producesFiles 能力）——先算路径，prepareInput 通过后再 mkdir，避免留空目录
    const workspace = spec.producesFiles
      ? opts.workspace
        ? resolve(process.cwd(), opts.workspace)
        : join(REPO_ROOT, "outputs", `${spec.id.replace(/\W+/g, "-")}-${randomUUID().slice(0, 8)}`)
      : (opts.workspace ?? "");
    const ctx: AbilityCtx = { workspace };

    const effInput = spec.prepareInput ? await spec.prepareInput(input, ctx) : input;
    if (spec.producesFiles) mkdirSync(workspace, { recursive: true });

    // 组合超时与外部取消为一个 signal
    const ac = new AbortController();
    const onParentAbort = (): void => ac.abort();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort();
      else opts.signal.addEventListener("abort", onParentAbort, { once: true });
    }
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? defaultTimeout);

    const backend = loadBackend(spec.agent);
    const session = await openBackendSession(backend, { pkgRoot: PKG_ROOT, repoRoot: REPO_ROOT, signal: ac.signal }).catch(
      (err) => {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onParentAbort);
        throw err;
      },
    );

    try {
      const wsNote = spec.producesFiles
        ? ["[产物目录]", `把生成的文件保存到这个目录：${workspace}`, "最终 JSON 里每个 path 用相对该目录的路径。"].join("\n")
        : undefined;
      const vars = spec.promptVars ? spec.promptVars(effInput, ctx) : undefined;
      let promptText = renderPrompt(template!, effInput, outSchemaJson, wsNote, vars);
      let lastViolation = "";
      for (let attempt = 0; attempt <= reviseMax; attempt++) {
        if (attempt > 0) promptText = revisePrompt(outSchemaJson, lastViolation);
        const raw = await session.prompt(promptText);
        const parsed = tryParseJson(raw);
        if (parsed === undefined) {
          lastViolation = "返回的不是合法 JSON";
          continue;
        }
        if (!outValidate!(parsed)) {
          lastViolation = ajv.errorsText(outValidate!.errors, { separator: "; " });
          continue;
        }
        if (spec.verifyOutput) {
          const v = spec.verifyOutput(parsed as Out, ctx);
          if (v) {
            lastViolation = v;
            continue;
          }
        }
        return spec.producesFiles
          ? ({ ...(parsed as Record<string, unknown>), workspace } as Out)
          : (parsed as Out);
      }
      throw new AbilityOutputError(`${spec.id} 产出始终不合要求（重试 ${reviseMax} 次后）：${lastViolation}`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onParentAbort);
      session.close();
    }
  }) as AbilityFn<In, Out>;

  fn.meta = { id: spec.id, description: spec.description };
  return fn;
}

function renderPrompt(
  template: string,
  input: unknown,
  outSchemaJson: string,
  wsNote?: string,
  vars?: Record<string, string>,
): string {
  const inputJson = JSON.stringify(input, null, 2);
  let body = template.includes("{{input}}")
    ? template.replaceAll("{{input}}", inputJson)
    : `${template}\n\n[输入]\n${inputJson}`;
  for (const [k, v] of Object.entries(vars ?? {})) {
    body = body.replaceAll(`{{${k}}}`, v);
  }
  return [
    body,
    "",
    ...(wsNote ? [wsNote, ""] : []),
    "[输出要求]",
    "你的最终回复必须且仅是一个 JSON 值，不要 markdown 代码块标记、不要任何解释或前后缀文字。",
    "严格匹配以下 JSON Schema：",
    outSchemaJson,
  ].join("\n");
}

function revisePrompt(outSchemaJson: string, violation: string): string {
  return [
    `上一次产出不合要求：${violation}。`,
    "请只重新输出一个合法 JSON 值（无代码块标记、无解释），严格匹配以下 schema：",
    outSchemaJson,
  ].join("\n");
}

/** 容错解析：剥 ```json 围栏；整体解析失败再退回抓第一个 {…}/[…] 片段。失败返回 undefined。 */
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
