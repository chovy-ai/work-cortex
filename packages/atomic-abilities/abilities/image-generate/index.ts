import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineDeclarativeAbility } from "../../core/ability.js";
import { AbilityInputError } from "../../core/errors.js";

export interface ImageGenerateInput {
  prompt: string;
  scenario?: string; // 显式指定 "domain/subtype" 或 "subtype"，跳过 codex 自选
  n?: number;
  ratio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
  reference_images?: string[]; // 图生图：参考图路径（相对调用方 cwd 或绝对）
  strength?: number; // 0–1，仅 reference_images 存在时有意义
  negative_prompt?: string;
  seed?: number;
  style?: string;
}

export interface GeneratedImage {
  path: string; // 相对 workspace
  width?: number;
  height?: number;
  seed?: number;
}

export interface ImageGenerateOutput {
  images: GeneratedImage[];
  revised_prompt?: string;
  workspace: string; // 框架注入：图片落盘的绝对目录（path 相对它解析）
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..", "..", "..");
const SRC_DIR = join(PKG_ROOT, "abilities", basename(HERE));
const SCENARIOS_DIR = join(SRC_DIR, "scenarios");

interface Scenario {
  domain: string;
  subtype: string;
  title: string;
  keywords: string[];
  method: "code" | "image";
  ref: string;
}

// 场景索引现读（改 scenarios.json / 加 md 无需重建）
function loadScenarios(): Scenario[] {
  const raw = JSON.parse(readFileSync(join(SCENARIOS_DIR, "scenarios.json"), "utf8")) as { scenarios: Scenario[] };
  return raw.scenarios;
}

function findScenario(scenarios: Scenario[], key: string): Scenario | undefined {
  return scenarios.find((s) => `${s.domain}/${s.subtype}` === key || s.subtype === key);
}

/** 构造注入 prompt 的 [场景配方] 块：显式场景 → 只指一份；否则给全量索引让 codex 自选。 */
function buildScenarioBlock(input: ImageGenerateInput): string {
  const scenarios = loadScenarios();
  if (input.scenario) {
    const s = findScenario(scenarios, input.scenario)!; // prepareInput 已校验存在
    return [
      `本次场景已指定：${s.title}（${s.domain}/${s.subtype}，method=${s.method}）。`,
      `请读取配方文件并严格遵循：${join(SCENARIOS_DIR, s.ref)}`,
    ].join("\n");
  }
  const lines = scenarios.map(
    (s) => `- ${s.domain}/${s.subtype}｜${s.title}｜关键词: ${s.keywords.join(" / ")}｜method: ${s.method}｜配方: ${s.ref}`,
  );
  return [
    `可用图型场景索引（配方目录：${SCENARIOS_DIR}）：`,
    ...lines,
    "请先判断本次请求最贴合哪个场景，用你的读文件能力读取对应「配方」文件（路径 = 配方目录 + 配方名），严格按其中规范产图。",
    "若都不贴合，按通用方式合理产图。",
  ].join("\n");
}

/** image.generate · 文生图 / 图生图 / 结构化图表。内部经 ACP 调 codex，按场景配方产图，落 workspace 返相对路径。 */
export const imageGenerate = defineDeclarativeAbility<ImageGenerateInput, ImageGenerateOutput>({
  id: "image.generate",
  description: "文生图 / 图生图 / 按场景渲染结构化图表（架构图、数据图、表格…）",
  agent: "codex",
  dir: SRC_DIR,
  producesFiles: true,
  limits: { timeoutMs: 300_000, reviseMax: 1 },
  prepareInput: (input) => {
    if (input.scenario && !findScenario(loadScenarios(), input.scenario)) {
      throw new AbilityInputError(`未知场景：${input.scenario}（见 scenarios.json）`);
    }
    if (!input.reference_images?.length) return input;
    const abs = input.reference_images.map((p) => {
      const full = isAbsolute(p) ? p : resolve(process.cwd(), p);
      if (!existsSync(full)) throw new AbilityInputError(`image.generate 参考图不存在：${p}`);
      return full;
    });
    return { ...input, reference_images: abs };
  },
  promptVars: (input) => ({ scenarios: buildScenarioBlock(input) }),
  verifyOutput: (out, ctx) => {
    for (const img of out.images) {
      if (!existsSync(resolve(ctx.workspace, img.path))) return `图片文件不存在：${img.path}`;
    }
    return null;
  },
});
