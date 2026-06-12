# 06 · data-analysis runner（能力薄壳）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

实现 `run(task, emit, signal)`：把一个 Task 变成一次 headless agent 执行——组装提示词、经 ACP 拉起 agent 跑现有 nextop-data-analytics 能力、把执行过程与最终回复翻译成 TaskEvent 流。**它是翻译壳，不是分析器**：所有分析智能在 agent + skill + domains/ 里。

不做：排队 / 并发 / 超时计时（05 runtime 管，本模块只需尊重 signal）、回复渲染（02 sender）。

## 依赖

- 01 契约（Task / TaskEventDraft）、05 的调用约定
- **ACP（Agent Client Protocol）**，选型原则：用社区使用最多、官方维护的包（用户定，2026-06-12）。已核实（npm 周下载，2026-06）：
  - 协议库 `@zed-industries/agent-client-protocol`（Zed 官方 = 协议原作方，~7k/周）
  - claude code 适配器 `@zed-industries/claude-code-acp`（Zed 官方，~9.5k/周）
  - codex 适配器：真要接入时按同一原则核实选型
- 本机对应 agent CLI 已安装并登录
- 仓库现有资产：`skills/nextop-data-analytics/SKILL.md`、`domains/`、`knowledge-store/`（要求 event-catalog.json 已生成——M0 知识更新仍手动跑）
- `.env.local`（DataFinder 凭据，agent 内工具读取）

## 接口与数据结构

### agent 调用方式（✅ 原 Q1：ACP，用户定）

每个 run 拉起一个 ACP agent 子进程（JSON-RPC over stdio）：

```
initialize → session/new（cwd = 仓库根）
→ session/prompt（组装好的提示词）
→ 订阅 session/update 通知：
    agent 消息块   → 累积为最终回复文本
    工具调用/更新   → 节流翻译成 progress（M0 只进 events.ndjson）
→ prompt 结束（stopReason 正常）→ emit result
```

选 ACP 的含义：**runner 与 agent 厂商解耦**。claude code / codex 都讲同一协议，切换 agent 是配置变更不是代码变更。这与三层架构的契约哲学同构——「能力壳 ↔ agent」这道接缝直接采用开源标准，不自研。

agent 选择经 capability.json 配置：

```jsonc
"runtime": {
  "type": "acp",
  "agent": "claude-code",          // 或 "codex"
  "cmd": "npx claude-code-acp"     // 适配器启动命令，按 agent 而异
}
```

注意：usage / token 统计是否透出取决于各适配器能力，M0 按尽力而为记录（有则落 `outputs/<run_id>/usage.json`），成本观测的完整方案归 M2。

### result 交付（✅ 原 Q2：最终消息即结果，用户定）

**agent 的最终回复文本就是结果**，runner 不做结构化提取、不要求 agent 写 result.json：

- 累积 ACP agent 消息块 → 完整 markdown 文本 → `emit({kind:"result", summary: <全文>, tables: [], charts: [], artifacts_dir})`；
- TaskEvent result 的 schema 不变（01 契约定全），M0 约定 `summary` 承载完整 markdown 回复，`tables` / `charts` 恒空——sender 直接把 summary 作为 markdown 发飞书；M1 再考虑结构化拆分；
- 回复的形态（结论先行、关键数字用 markdown 表格、附口径说明）作为输出格式要求写进提示词；
- prompt 结束但累积文本为空 / stopReason 异常 → emit error。

### 权限模式（✅ 原 Q3：完全开放，用户定）

agent 完全开放权限：ACP `session/request_permission` 回调一律允许；适配器支持 bypass 类启动参数的直接用参数。本机可信环境 + 常驻无人值守的前提下接受。`cwd` 仍设为仓库根（工作目录约定，非安全边界）。

### 提示词组装（M0 dashboard 直通车）

```
[引导]
你是数据分析执行器，按 skills/nextop-data-analytics/SKILL.md 工作。
本次只允许走 dashboard 路径（已有报表查询）；禁止 raw_analysis。
若 dashboard 无法回答该问题：不要尝试别的路径，直接回复说明无法回答
及原因，并建议等待深度分析能力上线。

你的最终回复将被原样发给飞书提问者，格式要求：
结论先行（一句话）→ 关键数字（markdown 表格）→ 简短口径说明。
不要包含执行过程叙述。运行产物目录：outputs/<run_id>/

[用户问题]
<task.input.text>
```

✅ **原 Q4（用户已接受）**：「只走 dashboard 路径」靠提示词约束 agent，与第八节「控制流永远 workflow」存在张力——**有期限豁免至 P3**。理由：dashboard 路径无 gate 无副作用，越界最坏后果是多花 token；P3 落地后 StepScheduler 接管路径控制，提示词约束退役。

### 取消语义

`signal` 触发 → `session/cancel` + 终止 agent 子进程（适配器负责清理其下游进程；宽限内未退干净则 kill）→ runner 不再 emit、直接返回（终态由 05 补 synthetic error）。

## 错误与重试

- agent 执行报错（登录失效 / API 错误 / 适配器崩溃）：emit error（reason 带摘要），不重试（05 已定）；
- 本模块不吞异常：抛出的异常由 05 接住统一收尾。

## 暂不做

| 项 | 回归时机 |
|---|---|
| raw_analysis 路径 + ask gate | M1（依赖 P3 StepScheduler） |
| 结果结构化拆分（tables / charts） | M1 |
| thread 追问上文注入 | M1 |
| 路径控制从提示词移交调度器 | P3 落地时 |
| token 预算传导与完整成本观测 | M2 |
| codex 适配器实测 | 第二 agent 真要用时 |

## 开放问题

全部关闭（2026-06-12，均用户定）：

- ~~**Q1 调用方式**~~ ✅ ACP 协议拉起（支持 claude code / codex，配置切换）。
- ~~**Q2 result 交付**~~ ✅ agent 最终回复文本即结果，经 TaskEvent result.summary 原样发往飞书。
- ~~**Q3 权限**~~ ✅ 完全开放（权限请求一律允许）。
- ~~**Q4 提示词约束路径**~~ ✅ 接受，豁免至 P3。

## 验收标准

- 给定 task「昨天 DAU 多少」，端到端：ACP 子进程拉起 → progress 进 events.ndjson → result.summary 为合规 markdown → run 终态 done；
- 给定 dashboard 无法回答的问题，回复为「无法回答 + 原因」而非自由发挥；
- run 中途 abort：agent 子进程及其下游退出（`ps` 无残留），runner 及时返回；
- 把 capability.json 的 `runtime.agent` 换成另一 ACP agent，runner 代码零修改可拉起（M0 至少验证启动握手）。
