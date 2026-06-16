/**
 * 原子能力的失败语义（对齐 ARCHITECTURE 第八节）：
 * - Input：上层传参错（workflow 失败，不调 agent）
 * - Runtime：agent 进程 spawn/超时/异常退出（workflow 失败）
 * - Output：产出始终不合 schema（LLM 质量问题，revise 用尽）
 * - Abort：上层取消 / 超时
 */
export class AbilityInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbilityInputError";
  }
}

export class AbilityOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbilityOutputError";
  }
}

export class AbilityRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbilityRuntimeError";
  }
}

export class AbilityAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbilityAbortError";
  }
}
