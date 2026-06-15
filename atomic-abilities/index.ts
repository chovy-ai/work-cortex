// atomic-abilities · 原子能力库对外入口
// 上层 import 带类型的能力方法即用；不感知背后的 agent / ACP。

export { docReview } from "./abilities/doc-review/index.js";
export type { DocReviewInput, DocReviewOutput, DocReviewIssue } from "./abilities/doc-review/index.js";

export { imageGenerate } from "./abilities/image-generate/index.js";
export type { ImageGenerateInput, ImageGenerateOutput, GeneratedImage } from "./abilities/image-generate/index.js";

export { runStructured, type RunStructuredOpts } from "./core/structured.js";

export type { AbilityOpts, AbilityFn, AbilityMeta, AbilityCtx } from "./core/ability.js";
export { createRegistry, type AbilityRegistry } from "./core/registry.js";
export {
  AbilityInputError,
  AbilityOutputError,
  AbilityRuntimeError,
  AbilityAbortError,
} from "./core/errors.js";
