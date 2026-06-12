# 03 · core · queue（内存队列与幂等）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

gateway 的唯一入水口：接收各连接器 `onEnvelope` 递交的 Envelope，做幂等去重和有界排队，按 FIFO 吐给下游（sessions/dispatcher）。不落盘（02-Q1 已定）。

不做：会话映射（04）、并发控制（05 runtime 管 worker 并发上限，队列只管顺序）、任何对 Envelope 内容的解读——队列眼里 Envelope 是不透明的，只读 `dedup_key`。

## 依赖

- 01 契约（Envelope）
- 上游：02 连接器（生产者）；下游：04 sessions（消费者）

## 接口与数据结构

```ts
export class EnvelopeQueue {
  constructor(opts: { maxSize: number; dedupCapacity: number });

  push(env: Envelope): PushResult;
  // "accepted" | "duplicate"（去重命中，静默丢）| "overflow"（队列满，丢弃 + 日志）

  consume(): AsyncIterable<Envelope>;
  // 单消费者 FIFO；dispatcher 用 for await 驱动

  stop(): void;   // 停止接收新事件，排空后 consume 迭代器结束（优雅退出用）
}
```

- **去重**：`dedup_key` 进有界 LRU 集合（容量 4096）。重复主要来自 WebSocket 重连后服务端重推，分钟级窗口，4096 条对私聊/小群流量是数量级冗余；有界保证内存恒定。命中即静默丢弃（这是正确行为，不是错误，记 debug 级日志即可）。失效模式已知并接受：跨 4096 条间隔的重复、跨进程重启的重复会被重复执行一次，后果是多答一次（查询只读，无数据损坏）。
- **有界队列**：`maxSize = 1000`（设长避免误溢出；约 1MB 内存，1000 深度 ≈ 十几小时积压——溢出即故障的判断不变，只是把误报余量放大）。
- **push 顺序**：**先查去重、再查容量**——重复事件不占溢出名额，防止重推风暴挤掉真实消息。
- **溢出**：拒绝新事件 + 错误日志 + 溢出计数器（累计值随日志输出，M2 接监控告警）。
- **顺序**：单队列全局 FIFO。同一会话的事件天然有序；不同会话之间的公平性 M0 不做（流量不需要）。

## 关键流程

```
listener.onEnvelope → push()
  ├─ dedup 命中 → 丢弃（debug 日志）
  ├─ 队列满   → 溢出策略（Q1）
  └─ 入队     → consume() 迭代器吐出 → sessions/dispatcher
优雅退出：service 收到 SIGTERM → queue.stop() → 排空存量 → 进程退出
```

## 错误与重试

队列自身无 I/O、无重试场景。唯一异常面是消费者处理单条 Envelope 时抛错——那是下游的失败，队列不回收、不重投（at-most-once 与不落盘语义一致）。

## 暂不做

| 项 | 回归时机 |
|---|---|
| 落盘持久化 | M1+（与 02 事件落盘同步） |
| 按会话公平调度 | 流量出现「单群刷屏饿死他人」时 |
| 重投 / 死信 | 引入落盘后才有意义 |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 溢出策略**~~ ✅ 拒绝新事件 + 错误日志（不反向依赖 sender；溢出 ≈ 故障，正确响应是修 runtime 而非安抚用户）。
- ~~**Q2 参数取值**~~ ✅ `maxSize=1000`（用户要求设长避免误溢出）、`dedupCapacity=4096`。两参数意义在「有界」本身，数值不敏感。

## 验收标准

- 同一 `dedup_key` push 两次，第二次返回 duplicate 且不出现在 consume 流中；
- push 第 `maxSize + 1` 条返回 overflow 并有错误日志；
- 1000 条乱序会话事件入队，consume 吐出顺序与入队顺序逐条一致（FIFO）；
- stop() 后 push 被拒绝，已排队事件全部吐完后迭代器正常结束。
