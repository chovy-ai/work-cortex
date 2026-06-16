# A1 · atomic-abilities（原子能力库）

状态：🚢 已实现（MVP；真实 agent 冒烟待跑）（2026-06-14）　|　层级：能力层公共库（与 service-gateway / domains 平级）

> 实现：[`../atomic-abilities/`](../atomic-abilities/)。`npm run build` 通过；no-agent 路径已验（meta 加载、资产从源码目录解析、input schema 在拉 agent 前强制）。`npm run smoke` 跑真实 claude 评审带 bug 的 diff —— 待 claude 认证环境下验收。codex 适配器已装（`@zed-industries/codex-acp` + darwin-arm64 二进制）。
>
> 首个消费方：查询执行域 ⑥ 报告步骤（`domains/query-execution/steps/report-charts.ts`，dashboard / raw-analysis 共用）调 `imageGenerate`（`data-analysis/chart` 场景）渲染图表。跨包接入方式：atomic-abilities 出 `.d.ts` + `main/exports`，根 `package.json` 以 `"atomic-abilities": "file:./atomic-abilities"` 引用；调度器步骤已支持 async。**注意：该报告步骤属 StepScheduler 结构化路径，尚未接入网关 runner（M0 飞书走 claude agent 直跑），故图表渲染待 P3 把调度器接进网关后才在飞书生效。**

## 职责与边界

给上层提供一个个**独立、带类型的原子能力方法**（生图、review…）。上层按代码调用，`输入 → 输出`，每个能力内部自己维护原子逻辑（绑定哪个 agent、prompt、ACP 调用、产出解析全藏在方法体里）。

不做：
- **不是 skill**——不被 agent 加载、没有 SKILL.md。上层愿意可自行把某个方法封装成 skill，与本模块无关。
- 不做编排（多能力怎么串是上层的事）、不做资源池（不接管 gateway `Runtime` 的全局并发槽）、不做能力路由（上层明确知道调哪个方法）。
- 不暴露 agent / prompt / ACP 概念——全是实现细节，对外只有方法的输入/输出类型。
- 不持久化、不发事件——纯库，`invoke` 进出；审计与进度由上层（capability runner）走既有 TaskEvent 机制。

## 依赖

- `@zed-industries/agent-client-protocol`、`@zed-industries/claude-code-acp`（已装）、`ajv` + `ajv-formats`（已装）
- `@zed-industries/codex-acp`（v0.16.0，bin `codex-acp`）—— 与 claude 适配器同 vendor、同分发方式，drop-in。**运行时前置**：它桥接 OpenAI Codex runtime，需 codex CLI 认证就绪。
- ACP 调用逻辑提炼自 `service-gateway/capabilities/data-analysis/runner.ts`（`createAcpRunner`）。

## 接口与数据结构

### 对外契约 = 方法签名 + I/O 类型（上层只见这一层）

```ts
// 每个原子能力 = 一个带类型的 async 方法，直接 import 使用
export function docReview(input: DocReviewInput, opts?: AbilityOpts): Promise<DocReviewOutput>;
export function imageGenerate(input: ImageGenInput, opts?: AbilityOpts): Promise<ImageGenOutput>;

export interface AbilityOpts {
  signal?: AbortSignal;   // 取消
  timeoutMs?: number;     // 覆盖默认预算
  workspace?: string;     // 产物落盘目录（produces files 的能力需要）
}

// 输入/输出类型是「唯一对外契约」，每个能力各自导出
export interface DocReviewInput  { diff: string; files?: string[] }
export interface DocReviewOutput { issues: { file: string; line?: number; severity: "high"|"med"|"low"; note: string }[] }
```

可选发现层（给数据驱动的上层，非主路径）：

```ts
export interface AbilityRegistry {
  list(): { id: string; description: string }[];
  get<In, Out>(id: string): (input: In, opts?: AbilityOpts) => Promise<Out>;
}
```

### 内部实现（对上层不可见，实现者二选一）

**A · 声明式（省事路径，跑 prompt 的能力用）**——共享骨架按声明拼出方法：

```ts
const docReview = defineDeclarativeAbility({
  id: "doc.review",
  agent: "claude",                  // 绑定的 backend id
  prompt: "./prompt.md",
  ioSchema: "./io.schema.json",     // 内部用于校验 + 派生 In/Out 类型
  limits: { timeoutMs: 120_000, reviseMax: 1 },
});
```

**B · 代码式（逃生口，有真实确定性逻辑的能力用）**——直接写 TS，可选借共享 backend helper 调 agent：

```ts
async function dataQuery(input, opts) {
  const rows = await datafinder.call(...);  // 真代码：签名 API / 本地计算
  return narrateWithAgent("claude", rows);  // 需要时再调 agent
}
```

两种实现导出的都是同样形态的方法，上层分不出区别。

### backend 声明（内部约定，非对外契约）

`backends/<id>.json`，供 A/B 共享的 ACP 调用读取：

```jsonc
{ "id": "claude", "transport": "acp", "cmd": "node_modules/.bin/claude-code-acp", "args": [],
  "cwd": ".", "env_strip": ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"], "permission": "allow_all" }
{ "id": "codex",  "transport": "acp", "cmd": "node_modules/.bin/codex-acp",      "args": [],
  "cwd": ".", "env_strip": [], "permission": "allow_all" }
```

新增能力 = 丢一个 `abilities/<name>/` 目录；新增 agent = 丢一个 `backends/<id>.json`。core 零改动（沿用仓库 `connector.json` / `module.json` 的「声明即接入」模式）。

## 关键流程

声明式能力的共享骨架（内部）：

```
方法(input, opts):
  1. 校验 input（不过 → AbilityInputError，不调 agent）
  2. 取 backend 声明 → 拉 ACP 子进程：initialize → newSession(cwd)
  3. prompt = render(prompt.md, input) + 结构化产出指令
  4. 流式接收 → 累积「最后一个工具调用后」的消息段（复用 runner.ts 策略）
  5. 解析 + 校验 output schema：
       合格            → 返回 typed Out
       不合格且有余量   → 带 violation 详情重新 prompt（回到 3）
       不合格且用尽     → AbilityOutputError
  6. produces files：产物写 opts.workspace，Out 里带相对路径（不回传二进制）
  7. signal / 超时：session/cancel → 2s → SIGTERM → SIGKILL（复用 runner.ts killChild）
```

代码式能力：任意 TS，结构与产出契约同样由 output schema 强制。

## 错误与重试（对齐 ARCHITECTURE 第八节失败语义）

| 失败 | 语义 | 处理 |
|---|---|---|
| input 不合类型 / schema | 上层传参错 | `AbilityInputError`，不调 agent |
| agent spawn 失败 / 超时 / 异常退出 | workflow 失败 | `AbilityRuntimeError`（是否重试由上层定，模块不自动重试） |
| 产出不合 output schema | LLM 质量问题 | revise 重新 prompt，上限 `reviseMax`；超限 `AbilityOutputError` |
| signal abort | 上层取消 | 协作取消 + 强杀子进程，`AbortError` |

**结构化产出硬执法**：方法返回的产出保证 schema 合法，否则抛错——**绝不返回非法数据**（已定，开放问题 1）。

## 暂不做

| 项 | 回归时机 |
|---|---|
| 多能力编排 / flow 引擎 | 上层有真实组合需求时单独立模块 |
| 共享 agent 进程池 / 全局并发上限 | 出现并发打爆时（可在模块加可选 semaphore） |
| 多轮 session 原子能力（一问一答之外） | 有交互型能力需求时 |
| 把能力暴露成 MCP tool（供 orchestrator agent 调用） | 接入 LLM 编排器时 |
| codex / claude 外第三种 backend | 按需 |

## 开放问题

全部关闭（2026-06-14）：

- ~~**Q1 结构化产出**~~ ✅ 方法返回必遵循 output schema：解析 → 校验 → revise（上限 `reviseMax`）→ 仍不过即 `AbilityOutputError`，绝不返回非法数据（用户定）。
- ~~**Q2 codex backend**~~ ✅ 用开源 `@zed-industries/codex-acp`（bin `codex-acp`），与 claude 适配器对称（用户定）。
- ~~**Q3 命名 / 编号**~~ ✅ 模块 `atomic-abilities`，文档 `design/A1-atomic-abilities.md`（用户定）。

## MVP 文件清单与验收

```
atomic-abilities/
├── package.json / tsconfig.json
├── core/
│   ├── ability.ts        # AbilityOpts、错误类型、defineDeclarativeAbility 共享骨架
│   ├── backend.ts        # ACP 适配器（提炼自 runner.ts，参数化 cmd/args/env_strip）
│   └── registry.ts       # list / get（可选发现层）
├── backends/{claude.json, codex.json}
└── abilities/
    ├── doc-review/{index.ts, prompt.md, io.schema.json}      # @claude，产文本 JSON
    └── image-generate/{index.ts, prompt.md, io.schema.json}  # @codex，文生图/图生图，产文件
```

### 产文件能力（produces files）

`image.generate` 经 ACP 调 codex 的生图能力，产出是图片**文件**而非文本。骨架为此加了通用支撑（`doc.review` 不受影响）：

- `DeclSpec.producesFiles: true` → 建 workspace（默认 `outputs/<id>-<uuid>/`，库不删），把其绝对路径注入 prompt，产出对象附 `workspace` 绝对路径字段；
- `prepareInput` 钩子：图生图时把 `reference_images` 解析为绝对路径 + 核对存在（缺图 → `AbilityInputError`，不拉 agent）；
- `verifyOutput` 钩子：过 output schema 之后再核对「报的图真落盘」，缺图当违约 → revise；
- 产出 `images[].path` 为**相对 workspace** 路径，`revised_prompt` 为 codex 实际采用的提示词（单条/整次请求）。

### 场景分流（类 skill reference）

`image.generate` 内部按业务场景分流到不同「渲染配方」，用类 skill reference 的方式——**把索引交给 codex，由它自选该读哪份配方**：

- `scenarios/scenarios.json` 是两级（domain → subtype）索引，每条含 `title / keywords / method(code|image) / ref`；
- `promptVars` 钩子把索引 + 配方目录绝对路径注入 prompt；codex 判断场景后**用读文件能力只读选中的那份 ref**（省 token，标准 skill reference 玩法），按配方产图；
- 逃生口：input 可选 `scenario`（`domain/subtype` 或 `subtype`）→ 只注入那一份、跳过 codex 自选，可强制锁定且可测；未知场景在拉 agent 前抛 `AbilityInputError`；
- **结构化图（架构/流程/时序/数据图/表格）配方标 `method: code`**：codex 写 mermaid / graphviz / SVG / matplotlib 渲染，不用栅格模型（文字框线会失真）——这正是 codex 编码 agent 的强项；偏视觉的才 `method: image`；
- 选场景这步是 codex（LLM）判断——属架构允许 LLM 介入的「理解/开放决策」语义鸿沟；确定性逃生口由显式 `scenario` 保留。
- 目录：`scenarios/{rnd,data-analysis,product-demo,product-analysis}/<subtype>.md`。MVP 种子配方：`rnd/architecture.md`（架构/流程/时序通用）、`data-analysis/chart.md`、`data-analysis/table.md`。

验收：
- `import { docReview }` → `docReview({ diff })` → 真实拉起 claude → 返回带类型、合 output schema 的问题清单；
- 构造一个让 agent 故意产出非法 JSON 的场景：revise 触发，仍不过则抛 `AbilityOutputError`，方法**不返回**非法数据；
- 传入超 `timeoutMs` 的任务：收到 abort，子进程被 SIGTERM/SIGKILL 清理，无僵尸进程；
- 接入 `codex.json` 后，一个 `agent:"codex"` 的声明式能力可同样跑通（codex 认证就绪前置）。
