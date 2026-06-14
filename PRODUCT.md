# service-gateway 产品与架构设计

> 与 ARCHITECTURE.md 平级的权威文档。ARCHITECTURE.md 管「分析能力怎么长」，本文管「能力怎么交付给团队」。
> 模块级设计沉淀在 [design/](design/README.md)，逐模块讨论定稿后按文档实现；本文只保留架构级结论。

---

## 一、产品定位

**把本仓库的能力从「工程师本机的 Claude skill」升级为「全团队可用的服务」**：团队成员在飞书（未来可以是其他应用）里用自然语言提问，常驻进程 `service-gateway` 接收消息、分发给具体能力执行、把结论回到会话。

三个本质特征：

- 用户从「会用 Claude Code 的维护者」扩展到「整个团队」；
- 接入端不绑定某一个 app —— **飞书（经 lark-cli）只是第一个连接器**；
- 能力端不绑定某一种分析 —— **数据 / 日志分析（本仓库查询链路）只是第一个能力**。

## 二、三层架构总览

```
层 1 · 连接器（每个 app 一个）          lark │ 未来：企业微信 · Slack · Web
────────────────── 契约：Envelope（入站） / ConnectorPort（出站） ──────────────────
层 2 · service-gateway（公共能力）      会话路由 · 队列幂等 · gate 挂起恢复
                                        身份权限 · cron 调度 · run 审计
────────────────── 契约：Task（下发） / TaskEvent（回流） ──────────────────────────
层 3 · 能力实现（每个能力一个）          data-analysis │ 未来：运维诊断 · 代码检索 …
```

**gateway 居中做双向中介**：对上不知道消息来自哪个 app，对下不知道任务由哪个能力执行。两道接缝各一对契约，跨层引用是架构违规：

- 连接器细节（lark-cli 命令、NDJSON、卡片 JSON、`om_/oc_` id 体系）只存在于 `connectors/lark/`；
- 能力细节（事件目录、DataFinder、StepScheduler）只存在于能力实现内；
- gateway 不做任何「智能」：意图理解、计划、评审全在能力层。它只做确定性的事：收、去重、排队、路由、转发、回。

**扩展方式统一**：新增连接器 = 丢一个目录进 `connectors/`；新增能力 = 丢一个目录进 `capabilities/`。各自带一份声明文件，core 零改动 —— 与 ④ 知识更新触发域的 `module.json` 模式同构。

## 三、用户与核心场景

| # | 场景 | 用户 | 路径 | 交互特征 |
|---|---|---|---|---|
| 1 | 即席问数（最高频） | PM / 运营 | data-analysis · dashboard | 无 gate，分钟级直接回答 |
| 2 | 深度分析 | 数据 / 研发 | data-analysis · raw_analysis | 先回「分析方案确认卡片」，确认后执行 |
| 3 | 订阅推送 | 团队 / 群 | dashboard + cron | 日报 / 周报定时推群；冷启动抓手 |
| 4 | 维护者通知 | 维护者 | TaskEvent signal | 知识缺口不是失败了事，推维护者群闭环到 ④ 域 |

## 四、交互设计

### 关键契合点：`await_input` gate ↔ IM 交互消息

ARCHITECTURE.md 中 `B_user_review` gate 的设计是「挂起等输入、state.json 持久化、可 resume」。穿过三层它是这样流动的：

```
能力层：StepScheduler 走到 gate → 发 TaskEvent{kind:"ask", prompt, options}
层 2：  记录 run 挂起，经 ConnectorPort.ask() 转给来源连接器
层 1：  lark 连接器渲染成交互卡片（卡片 value 带 run_id）
用户：  点「确认 / 修改 / 取消」
层 1：  card.action.trigger 回调 → 翻译成 Envelope{kind:"action", run_id}
层 2：  按 run_id 找到挂起的 run → 下发 Task{resume:{action_id}}
能力层：StepScheduler resume
```

CLI 里别扭的「停下来等人敲字」，在 IM 里是最自然的交互。

### 会话模型

- 一条消息 = 一次 run；**追问在 thread 里回**，`conversation.thread_id` 映射到 run 上下文，群里多人多话题不串线。
- 不支持 thread 的连接器降级为「同会话最近一次 run」。

### 进度与结果

- 收到提问先回执「正在分析」（progress），长任务原地更新，不石沉大海。
- 结果形态固定四段：**结论先行**（一句话）→ 关键数字表格 → 图表 → 折叠的口径说明 + `run_id`（可追溯 `outputs/<run_id>/`）。

## 五、接缝一：连接器契约

### 入站 Envelope

每个连接器 listener 把原始事件翻译成统一信封，层 2 只认它：

```jsonc
{
  "event_id": "evt_xxx",            // 渠道事件 id，幂等去重键
  "channel": "lark",
  "conversation": {
    "id": "oc_xxx",                 // 渠道会话 id
    "thread_id": "omt_xxx | null",
    "type": "p2p | group"
  },
  "principal": { "channel_user_id": "ou_xxx", "display_name": "…" },
  "kind": "message | action | system",
  "message": { "text": "昨天 DAU 多少", "attachments": [] },   // kind=message
  "action": {                                                   // kind=action（gate 回调）
    "run_id": "…",
    "action_id": "confirm | revise | cancel",
    "params": {}
  },
  "raw": {}                          // 渠道原始事件，仅连接器内调试用，层 2 不读
}
```

### 出站 ConnectorPort

层 2 需要的出站动作只有五个，每个连接器实现：

```
send_text(conversation, text)                        # 普通回复
send_progress(conversation, run_id, status) → handle # 可更新的进度载体
update_progress(handle, status)
ask(conversation, run_id, prompt, options[])         # human gate；用户操作以 action Envelope 回流
send_result(conversation, run_id, result)            # 结论 + 表格 + 图
```

### 能力声明与降级：connector.json

```jsonc
{
  "id": "lark",
  "listen": {
    "type": "subprocess",            // 未来 webhook 型连接器：type=http
    "cmd": "lark-cli event +subscribe --event-types im.message.receive_v1 --quiet"
  },
  "capabilities": {
    "thread": true,            // false → 降级为「同会话最近一次 run」
    "message_update": true,    // false → update_progress 降级为追加新消息
    "actions": true,           // false → ask 降级为文本菜单「回复 1 确认 / 2 修改 / 3 取消」
    "format": "lark_card"      // 结果渲染方言
  }
}
```

gate 语义对所有连接器不变，变的只是呈现。飞书交互卡片是 `ask()` 的最豪华实现，不是前提。

## 六、接缝二：能力契约

### 下发 Task

```jsonc
{
  "run_id": "…",
  "capability": "data-analysis",
  "input": { "text": "昨天 DAU 多少", "attachments": [] },
  "context": {
    "principal": { "member": "…", "roles": ["analyst"] },   // 层 2 已完成身份映射
    "conversation_ref": "opaque",                            // 能力层不可解读，仅原样带回
    "history": []                                            // thread 追问的上文摘要
  },
  "resume": null | { "action_id": "confirm", "params": {} }  // gate 恢复时携带
}
```

### 回流 TaskEvent（流式）

```
{ "kind": "progress", "status": "正在解析口径…" }
{ "kind": "ask", "prompt": "...", "options": ["confirm","revise","cancel"] }   // ← StepOutcome.await_input
{ "kind": "result", "summary": "…", "tables": [...], "charts": [...], "artifacts_dir": "outputs/<run_id>" }
{ "kind": "error", "reason": "…" }                                             // ← StepOutcome.abort
{ "kind": "signal", "type": "knowledge_gap", "detail": {...} }                 // 缺口信号 → 维护者通知
```

**与 StepOutcome 的同构**是这道接缝便宜的原因：`await_input → ask`、`done → result`、`abort → error`，data-analysis 能力的 runner 只是把调度器状态翻译成 TaskEvent 的薄壳。

### 能力声明：capability.json

```jsonc
{
  "id": "data-analysis",
  "description": "nextop 产品数据 / 日志分析（本仓库查询链路）",
  "match": { "default": true },      // 单能力期全量路由；多能力后：命令前缀 → 关键词 → LLM 路由
  "runtime": {
    "type": "acp",                   // ACP 协议拉起 agent 跑 skill
    "agent": "claude-code",          // 或 "codex"，配置切换
    "cmd": "npx claude-code-acp"
  },
  "permissions": {
    "dashboard": "all",              // 即席问数全员可用
    "raw_analysis": "allowlist"      // 真实调 DataFinder / Kafka，仅白名单
  }
}
```

**能力路由**：单能力期 `default: true` 全量分发；多能力后路由顺序为 命令前缀（`/数据`）→ 关键词 → 轻量 LLM 路由。注意这与能力内部的 ⑤ 意图路由域是两回事：gateway 路由只决定「给谁」，⑤ 决定「怎么做」。

## 七、层 2 能力范围：只保留必要的

原则：**契约定全，实现做少**。Envelope / Task / TaskEvent 三个 schema 按完整设计落地（契约返工最贵），但 gateway 实现只保留「没有就跑不通」的四件事，其余预留在契约里、按里程碑补实现。

### 必要能力（现在做）

| 能力 | 说明 |
|---|---|
| 队列与幂等 | 连接器管道直读事件 → 内存队列；`dedup_key` 去重；M0 不落盘（进程死亡丢在途事件，已接受） |
| 会话映射 | `(channel, conversation, thread) → run_id`；run 状态 running / done |
| 运行时托管 | 按 capability.json 起 headless agent，管并发上限与排队 |
| 出站转发 | TaskEvent（progress / result / error）→ 来源连接器的 ConnectorPort 调用 |

### 暂不实现（契约已预留位）

| 能力 | 预留在哪 | 何时做 |
|---|---|---|
| gate 挂起恢复 | `TaskEvent.ask` / `Task.resume` / `Envelope.action` | M1（raw_analysis 确认卡片） |
| 身份与权限 | `Envelope.principal` / capability.json `permissions` | M1（开放 raw_analysis 时） |
| cron 调度 | 订阅类 Task | M2 |
| 审计 | run 留档（M0 先靠现有 `outputs/<run_id>/`） | M2 |
| 信号转通知 | `TaskEvent.signal` | M2 |
| 能力路由 | capability.json `match` | 第二能力接入时（M3）；现在常量直连 data-analysis |
| 连接器降级 | connector.json `capabilities` | 第二连接器接入时（M3）；lark 全能力无需降级 |
| 事件落盘队列（崩溃不丢） | `Envelope.raw_ref`（M0 恒 null） | 需要可靠性保证时（M1+） |

## 八、workflow 与 LLM 的分界

总原则：**LLM 只产出数据，不产出控制流。**

1. **控制流永远是 workflow**：编排（StepScheduler）、分支（S2 按 schema 字段）、重试计数、gate 打回到哪一步，全部由 workflow.json + 调度器决定。LLM 评审可以给出 `requires_revision` 的「意见」，但打回与否、打回到哪、还剩几次重试，是调度器的规则。
2. **LLM 输出必须落 schema**：QueryIntent / QueryPlan / CompiledQuery 各有 `.schema.json`，workflow 校验不过就地打回。LLM 永远不直接驱动副作用——API 调用、发消息都由 workflow 执行。
3. **失败语义不同**：workflow 失败 = 缺陷或环境问题 → 重试 / 报 error；LLM 输出不合格 = 质量问题 → 走 gate 打回（revise）。
4. **LLM 只放在四类「语义鸿沟」**：理解（NL→结构化）、开放决策（选事件 / 口径 / 算法）、评审判断（计划合理吗 / 结果可信吗）、叙述（数字→结论）。其余一律 workflow。

### 按层划分

| 层 | 结论 |
|---|---|
| 层 1 连接器 | 100% workflow，事件解析、卡片渲染全确定性 |
| 层 2 gateway | 100% workflow（「不做智能」原则）；未来能力路由优先命令前缀 / 关键词，LLM 路由是 M3+ 的最后手段 |
| 层 3 能力内 | 混合区，按 step 划分见下表；StepScheduler 本身是 workflow |
| 知识更新链路 | module.json `type=script` = workflow（①③）；`type=agent` = LLM 读文档改 manifest（②） |

### 查询链路 step 明细

| step | 承担方 | 说明 |
|---|---|---|
| S1 理解 | LLM → schema | **唯一必经的 LLM 入口**；QueryIntent 受 schema 约束 |
| S2 路由 | workflow | 按 query_path 字段分支 |
| A 解析资产 | 混合 | 候选检索 workflow，模糊挑选 LLM |
| A 编排 / 编译 / 执行 | workflow | 时间参数、模板填参、API 调用 |
| A 报告 | LLM + workflow | 叙述 LLM；表格 / 图表渲染 workflow |
| B 准备 | LLM → schema | 读 knowledge-store 选事件与口径 |
| B 自动评审 | LLM gate | subagent 评审；revise 上限 2 由调度器管 |
| B 用户确认 | human gate | await_input → ask 卡片 |
| B 计划 | LLM → schema | QueryPlan，schema 校验 |
| B 编译 / 执行 | workflow | CompiledQuery 校验通过才允许执行 |
| B 质量校验 | 混合 gate | 确定性检查先行（空结果 / 行数 / 数值范围），LLM 合理性判断后置 |
| B 报告 | LLM + workflow | 同 A 报告 |

### 成本与演进

- **dashboard 是高频热路径**，M2 优化目标是「热路径趋零 LLM」：常见问法 → QueryIntent 缓存命中跳过 S1；解析资产用报表别名表替代 LLM 挑选；报告用模板化叙述。LLM 退化为 cache miss 时的兜底。
- **raw_analysis 低频高价值**，LLM 密集是合理的。规律：**LLM 密度与 gate 密度成正比**——LLM 含量越高的路径，越需要 workflow 规则和人来把关，这正是 B 路径有三道 gate 而 A 路径零 gate 的原因。

## 九、目录结构

```
service-gateway/                   # 独立 TS 包（Node ≥ 20，package.json + tsconfig）
├── connectors/                    # 层 1：每个 app 一个
│   └── lark/
│       ├── connector.json         # 能力声明 + listen 启动方式
│       ├── listener.ts            # 托管 lark-cli 子进程，原始事件 → Envelope
│       └── sender.ts              # ConnectorPort 实现（im +messages-send / api POST 卡片）
├── core/                          # 层 2：连接器无关 · 能力无关（只保留必要四件）
│   ├── envelope.schema.json       # 契约定全：含 action / principal 等预留字段
│   ├── task.schema.json
│   ├── task-event.schema.json
│   ├── queue.ts                   # 内存队列 + dedup_key 幂等（M0 不落盘）
│   ├── sessions.ts                # 会话映射 + run 状态
│   └── runtime.ts                 # headless agent 托管 + TaskEvent 出站转发
│   # 暂不建：router.ts（常量直连 data-analysis）、principals.json（M1）、
│   # gate resume（M1）、事件落盘（M1+）、cron / 审计 / signal（M2）
├── capabilities/                  # 层 3：每个能力一个注册壳
│   └── data-analysis/
│       ├── capability.json
│       └── runner.ts              # Task → 驱动 domains/ 查询链路 → TaskEvent
└── service.ts                     # daemon 入口：拉起连接器 listener + 消费循环
```

**语言边界与接缝重合**：service-gateway 三层全 TS；data-analysis 能力的「真身」（`domains/` 下 DataFinder 签名客户端、事件提取、executors）保持 Python——它们由 headless agent 经 Bash/CLI 调用，本来就隔着进程边界，TaskEvent 契约是 JSON，跨语言零成本。能力侧后续新建的代码（P3 调度器、④ 域控制平面）同样 TS-first，仅当复用既有 Python 工具链或生态强依赖时才新写 Python。

注意：**data-analysis 能力的「真身」就是仓库现有的 `domains/` + `skills/`**，`capabilities/data-analysis/` 只是把它注册进 gateway 的薄壳。未来新能力同样以薄壳注册，实现可以在别的仓库。

## 十、已定决策

| 决策点 | 结论 | 理由 |
|---|---|---|
| 进程命名 | `service-gateway` | 居中中介，对 app 与能力双向解耦 |
| 分层 | 连接器 / gateway / 能力实现 三层 | 两道接缝各一对契约，跨层引用违规 |
| 层 2 范围 | 契约定全，实现只保留必要四件：队列幂等 / 会话映射 / 运行时托管 / 出站转发 | gate、权限、cron、审计、路由、降级均预留契约位，按里程碑补 |
| workflow / LLM 分界 | 第八节四条规则：控制流永远 workflow；LLM 输出必须落 schema；失败语义分开；LLM 仅限四类语义鸿沟 | S1 是唯一必经 LLM 入口；LLM 密度与 gate 密度成正比，可作新能力设计检查项 |
| 实现语言 | **全仓库 TypeScript**（2026-06-12 用户决定全量迁移，Python 已清零） | 工具经根目录 `npm run build:tools` 编译至 `build/`，以 `node build/domains/.../x.js` 调用；kafkajs / duckdb 懒加载替代 kafka-python / duckdb(pip)；迁移经逐字节输出回归验证 |
| LLM 运行时 | **ACP（Agent Client Protocol）拉起 agent**，支持 claude code / codex 配置切换 | 「能力壳 ↔ agent」接缝采用开源标准契约，与三层架构哲学同构；复用现有 skill / domains 零迁移；纯确定性 dashboard path 留作 M2 成本优化 |
| 飞书接入方式 | lark-cli `event +subscribe` WebSocket 长连接 | 无需公网 webhook；stdout NDJSON 管道直读（M0 不落盘）；自带单实例锁 |
| 部署 | 先本机 launchd 跑通，验证价值后迁服务器 | `.env.local`、nextop 本地仓库、claude 环境都现成 |
| 权限 | open_id 白名单起步 | raw_analysis 限白名单，dashboard 放宽 |

## 十一、路线图

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| **M0 直通车** | lark 私聊问答 → data-analysis dashboard path（无 gate），文本回复；gateway 只含必要四件；三个契约 schema 落全，验证三层端到端 | 不依赖 P3 |
| **M1 完整问数** | gate 挂起恢复 + raw_analysis 确认卡片 + thread 追问 + 进度卡片更新（M0 已先以文本消息原地更新落地）+ 身份白名单 | P3 StepScheduler |
| **M2 主动性** | 订阅日报（cron → Task）、知识更新定时调度、signal 推维护者群 | M1、④ 域 |
| **M3 规模化** | 异动告警、权限细化、成本看板、迁服务器、第二连接器或第二能力接入验证扩展性 | M2 |
