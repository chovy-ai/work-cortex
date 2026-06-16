# 05 · core · runtime（agent 托管与出站转发）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

执行引擎：从 sessions 接收 Task，在全局并发上限内调用能力 runner，对 runner 吐出的每条 TaskEvent 做校验 → 补全簿记字段 → 持久化（events.ndjson）→ 转发回 sessions；执行超时强制收尾。

不做：会话语义（04）、能力内部逻辑（06 runner）、回复渲染（02 sender）。runtime 眼里 runner 是黑盒函数，Task 与 TaskEvent 是全部界面。

## 依赖

- 01 契约（Task / TaskEvent schema）
- 上游：04 sessions；下游：06 runner（M0 常量直连 data-analysis，无路由）
- `outputs/` 目录可写

## 接口与数据结构

```ts
export class Runtime {
  constructor(opts: {
    maxConcurrent: number;                  // 全局执行槽，来自 service 配置（07 定配置形态），M0 默认 1
    onEvent: (e: TaskEvent) => void;        // 校验+补全后的事件，交 sessions 回流处理
  });
  submit(task: Task): void;                 // 槽满则入全局 FIFO 等待（无界——上游 03/04 均有界，天然受限）
}
```

### runner 调用约定（涉及契约修订，Q2）

```ts
// 能力 runner 的最终签名（01 的 run(task, emit) 细化）：
export async function run(
  task: Task,
  emit: (draft: TaskEventDraft) => void,   // draft = { kind, ...载荷 }，不含 v/run_id/seq/at
  signal: AbortSignal,                     // 超时/停机时触发，runner 负责善后自己拉起的子进程
): Promise<void>;
```

- **簿记字段由 runtime 补全**：runner 只 emit `kind + 载荷`，`v / run_id / seq / at` 由 runtime（单一写者）盖章——seq 单调性不再依赖每个能力作者自觉；
- 补全后过 ajv 校验 → append 到 `outputs/<run_id>/events.ndjson` → `onEvent`。

### 每个 run 的执行流水

```
submit(task)
  → 等槽（FIFO）→ 占槽
  → 建 outputs/<run_id>/，落 task.json（输入快照——run 记录自包含，与 events.ndjson 合为完整持久轨迹）
  → run(task, emit, signal) 与 timeout 赛跑（task.limits.timeout_s）
     ├─ 正常返回：检查终态事件恰好一条（result | error），缺失则补 synthetic error
     ├─ 抛异常：synthetic error（reason = 异常摘要）
     └─ 超时：signal.abort() → 宽限 10s 等 runner 善后 → 仍未返回则放弃等待，
              synthetic error（reason=timeout）、释放槽，残余 emit 一律丢弃（warn）
  → 释放槽 → 全局等待队列取下一个
```

### 终态唯一性的强制（契约执法点）

01 规定终态事件有且仅有一个。runtime 是执法者：

- runner 终态后再 emit 任何事件 → 丢弃 + warn；
- runner 返回但没发过终态 → runtime 补 synthetic error；
- TaskEvent 校验失败 → 该 run 立即以 synthetic error 收尾（01 已定的失败语义），signal.abort() 通知 runner 停工。

## 错误与重试

- runner 异常 / 超时 / 违约：一律 synthetic error 终态，**不重试**（LLM run 非幂等且贵；用户重发即重试）；
- events.ndjson 写失败（磁盘满等）：错误日志 + 继续转发（审计缺一条不挡回复）；
- 同进程风险（01-Q2 已接受）：abort 后 runner 若不配合（死循环），槽已释放、事件已丢弃，泄漏的是一个挂起的 Promise——子进程清理是 06 runner 的验收责任。

## 暂不做

| 项 | 回归时机 |
|---|---|
| 能力路由（多 runner） | M3，capability.json `match` |
| token 预算控制 | M2（events.ndjson 先积累观测数据） |
| run 级重试策略 | 确有需求再说（用户重发即重试） |
| 执行槽动态调整 | M2 监控就位后 |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 maxConcurrent**~~ ✅ 可配置项（07 服务配置），M0 默认 **1**（用户定）。
- ~~**Q2 契约修订 R2**~~ ✅ 认可：`run(task, emit(draft), signal)`，簿记字段由 runtime 补全，已记入 01 修订记录。
- ~~**Q3 超时宽限**~~ ✅ 10s。

## 验收标准

- 并发压 5 个 Task，任意时刻 running ≤ maxConcurrent，完成顺序释放槽位且等待队列 FIFO；
- runner 正常返回：events.ndjson 含完整事件流，seq 严格递增，终态恰一条；
- runner 抛异常 / 不发终态 / 终态后继续 emit / emit 非法事件：四种违约场景均按本文语义收尾，run 必达终态；
- 构造一个 sleep 超过 timeout_s 的 runner：收到 abort，10s 内未返回则 run 以 timeout error 收尾、槽位释放；
- kill -TERM gateway：占用中的槽对应 run 直接消失（M0 接受），无僵尸 claude 子进程残留（与 06 联合验收）。
