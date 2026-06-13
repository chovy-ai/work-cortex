# 04 · core · sessions（会话映射与 run 状态）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

队列与执行之间的决策层：从 queue 消费 Envelope，决定它的命运（开新 run / 忽略 / 提示），维护 run 注册表与状态，构造 Task 交给 runtime，并把 runtime 回流的 TaskEvent 寻址回正确的会话（解码 `conversation_ref`）。

不做：执行（05 runtime）、回复的渲染与发送（02 sender）、对消息文本的任何理解（能力层的事）。

## 依赖

- 01 契约（Envelope / Task / TaskEvent）
- 上游：03 queue（消费者）；下游：05 runtime（提交 Task）、02 sender（经 runtime 出站转发寻址）

## 接口与数据结构

### run 注册表（内存）

```ts
interface RunRecord {
  run_id: string;            // "run_" + UTC 紧凑时间 + 短随机量，同时是 outputs/<run_id>/ 目录名
  channel: string;
  conversation: Conversation;     // 含 thread_id，回复寻址用
  status: "running" | "done" | "failed";   // M1 增加 "awaiting"（gate 挂起）
  created_at: string;
}
// Map<run_id, RunRecord>；终态记录保留最近 512 条（LRU），完整痕迹以 outputs/<run_id>/ 为准
```

### Envelope 的命运判定（M0 决策表）

| 入站情况 | 处理 | 说明 |
|---|---|---|
| `kind=message`，p2p，该会话无 running run | **开新 run** | 主路径 |
| `kind=message`，p2p，该会话已有 running run | **入该会话待跑队列**（按到达序，✅ 原 Q1） | 前一 run 终态后自动开跑下一条 |
| `kind=message`，group | 忽略 + debug 日志（✅ 原 Q2） | M0 仅私聊 |
| `kind=action` | 忽略 + warn 日志 | M1 才有 gate |
| `kind=system` | 忽略 | — |

### 会话待跑队列（per-conversation pending）

- 每个会话一个 FIFO 列表，元素是已翻译的 Envelope；到达顺序由 03 全局 FIFO 天然保证；
- **同会话严格串行**：任意时刻一个会话至多一个 running run；终态（done / failed）时弹出下一条立即构造 Task 提交；
- 有界：单会话 pending 上限 10 条，超出丢弃 + 错误日志 + **一次性溢出提示**（`OVERFLOW_TEXT`，每轮溢出只提示一次，成功入队后复位；防单人刷屏占满内存又不让丢弃静默无声）；
- **排队也回执**：入队即在该消息上贴「工作中」reaction（句柄随排队项带到开跑时沿用，不重复贴），别让用户以为追问被无视；渠道无 reaction 时降级排队文案（`RECEIPT_QUEUED_TEXT`）；
- 不跨会话排队——不同会话的并行度由 05 runtime 的全局执行槽控制。

### conversation_ref（不透明寻址令牌）

`base64(JSON({channel, conversation}))`——core 编码 / 解码，能力层原样携带。TaskEvent 回流时 sessions 解码它，把 result/error 寻址到来源会话交给 sender。

### Task 构造

- `input.text` ← `message.text`；`history` 恒空（M0）；`resume` 恒 null（M0）；
- `principal.member` ← 透传 `channel_user_id`（M1 接 principals 映射）；
- `limits.timeout_s = 600`。

### TaskEvent 回流处理（M0）

| kind | 处理 |
|---|---|
| `result` | run → done；解码 conversation_ref → sender.send_result |
| `error` | run → failed；→ sender.send_text（「分析失败：…」），reason 经 `friendlyError` 翻成业务同学看得懂的话（超时/未产出/执行异常映射为人话，其余原样透传；原始 reason 仍在 events.ndjson）。不糖衣坏消息，只是去工程腔 |
| `progress` | **原地更新**（支持 `send_progress`/`update_progress` 的渠道，如飞书）：首条进度发一条新消息记下 message_id 句柄，其后 `update_progress` 原地改同一条（≥5s 间隔，仅防 API 频控），长任务只占一条气泡不刷屏；不支持的渠道降级逐条追加（≥30s 间隔防刷屏）。回执为**状态指示器 reaction**（用户定，2026-06-12）：开跑在源消息贴 💪 MUSCLE（=工作中），**终态回复发出前先撤掉**（deliverAfterClearingReceipt，撤失败不挡回复）；渠道无 reaction 能力时降级文本回执。回执是 reaction（非气泡），故首条进度可立即外发。正文/系统文案禁用 [表情] 短代码（实测不渲染） |
| `ask` / `signal` | M0 不应出现；出现即 warn 日志 + 该 run 按 error 收尾 |

## 关键流程

```
queue.consume() → 判定表 → 开新 run：
  生成 run_id → 注册 running → 构造 Task → runtime.submit(task)
  → TaskEvent 流回 → result/error → 终态 + 寻址回复 → LRU 归档
超时（runtime 报）：等同 error（reason=timeout）
```

## 错误与重试

- 判定/构造阶段抛错：该 Envelope 丢弃 + 错误日志（与 at-most-once 一致，不重投）；
- run 终态后迟到的 TaskEvent（理论不应有）：warn 日志丢弃；
- sender 发送失败不改变 run 状态（02 已定）。

## 暂不做

| 项 | 回归时机 |
|---|---|
| `awaiting` 状态 + action 路由 | M1（08-gate-resume） |
| thread 追问（history 构造） | M1 |
| 群聊 + @机器人 | M1 |
| run 状态持久化（重启恢复 running run） | 与事件落盘同期（M1+）；M0 重启 = 跑着的 run 作废，用户重发 |
| principals 身份映射 | M1（09-principals） |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 同会话并发**~~ ✅ 按到达时间排队（用户定）：同会话严格串行，内部 per-conversation FIFO，前一 run 终态自动跑下一条。见「会话待跑队列」节。
- ~~**Q2 群聊消息**~~ ✅ M0 忽略 + debug 日志（机器人在群里乱插话比沉默更糟），M1 做群 + @。
- ~~**Q3 提示拒绝算不算 run**~~ ✅ 随 Q1 改选排队而消解（无提示行为）。

## 验收标准

- 同一 p2p 会话连发三条：第一条开 run，后两条入待跑队列；第一条终态后第二条自动开跑，顺序与到达序一致；任意时刻该会话至多一个 running；
- 单会话 pending 压到第 11 条被丢弃且有错误日志；
- 群消息 / action / system 按判定表处理，注册表无变化；
- result 回流后：状态 done、回复出现在来源 thread、events.ndjson 完整；
- 终态记录超过 512 条时 LRU 淘汰，内存不增长。
