# 02 · lark 连接器（listener + sender）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

双向翻译官：把 lark 的事件世界翻译成 Envelope（入站），把 ConnectorPort 调用翻译成 lark-cli 命令（出站）。lark 的一切细节（`om_/oc_/ou_` id 体系、卡片 JSON、lark-cli 用法）只存在于本模块。

不做：排队与幂等（core/queue 管）、会话状态（core/sessions 管）、任何业务判断。

## 依赖

- 01 契约（Envelope schema）
- lark-cli ≥ 1.0.6（已验证：`event +subscribe` WebSocket 长连接、`im +messages-send/+messages-reply`、generic `api`）
- 飞书自建应用凭据：本机 lark-cli profile 已配置，bot 身份可用（部署前提，`lark-cli doctor` 可自检）

## 接口与数据结构

### listener（入站：子进程托管 + 管道直读 + 翻译）

✅ **事件获取形态（原 Q1，2026-06-12 定）**：stdout NDJSON 管道直读，**M0 不落盘**。事件从 lark-cli 子进程的 stdout 流进 gateway 进程，逐行解析 → translate → 直接递交 core 内存队列。崩溃语义：进程死亡时在途/排队中的事件丢失，M0 接受（私聊试用阶段）；落盘可靠性是预留的回归项（见「暂不做」）。

```
托管子进程：
lark-cli event +subscribe
  --event-types im.message.receive_v1          # M0 只订消息；M1 追加 card.action.trigger
  --quiet                                       # stdout 只剩 NDJSON 事件流
```

```ts
export function startListener(
  onEnvelope: (env: Envelope) => void,   // 翻译成功即回调，由 core/queue 接走
): ListenerHandle;                        // { stop(): Promise<void> }
```

- 逐行读 stdout（处理半行缓冲），每行 JSON.parse → `translate()` → 过 schema 校验 → `onEnvelope`；
- 解析失败 / 校验失败的行：记错误日志（含原文），跳过，不阻塞流；
- 重拉策略：子进程退出 → 指数退避 1s → 2s → … → 60s 封顶重拉，成功收到事件后退避归零；单实例锁依赖 lark-cli 自带（绝不用 `--force`）。

### translate（纯函数，listener 内部调用）

```ts
function translate(rawEvent: unknown): Envelope | null;
// null = 该事件与我们无关（机器人自己发的消息回显等），直接丢弃
```

- 映射：`im.message.receive_v1` → `kind=message`（提取纯文本，剥掉 @机器人 mention）；`card.action.trigger` → `kind=action`（M1）；
- `dedup_key = "lark:" + event_id`；
- `raw_ref = null`（M0 无落盘文件，字段可空——契约 01 的修订记录见该文档）；
- 自我消息过滤：sender open_id == 机器人自身 → null（防自激回环，连接器内唯一必须有的判断）。

### sender（出站，ConnectorPort 实现）

| ConnectorPort | M0 实现 | 说明 |
|---|---|---|
| `send_text` | `lark-cli im +messages-send --chat-id … --msg-type text` | p2p / 群通用 |
| `send_result` | `+messages-reply` markdown：summary + tables 转 markdown 表格 | thread 内回复原消息；charts M0 不发（Q3） |
| `send_progress` / `update_progress` | M0 不实现 | M1（依赖卡片） |
| `ask` | M0 不实现 | M1（08-gate-resume） |

- 每次调用 = spawn 一次 lark-cli（短命令，无长驻）；
- 失败语义：非零退出码 + stderr 归集进日志；网络类错误重试 2 次（指数退避），仍失败则记错误日志放弃——**结果仍在 `outputs/<run_id>/`，不回滚 run**（M0 接受人工补发）。

### connector.json

```jsonc
{
  "id": "lark",
  "listen": {
    "type": "subprocess",
    "cmd": "lark-cli event +subscribe --event-types im.message.receive_v1 --quiet"
  },
  "capabilities": { "thread": true, "message_update": true, "actions": true, "format": "lark_card" }
}
```

## 关键流程

```
正常：lark 用户发消息 → WebSocket → lark-cli → stdout NDJSON
      → listener 逐行解析 → translate() → Envelope → core/queue（内存）
      → …执行… → sender.send_result() → lark-cli +messages-reply → 用户在 thread 看到结果

listener 崩溃 / gateway 重启：重连窗口内的事件丢失（M0 接受，见 Q4）；
                              排队未处理的事件随进程丢失（M0 接受）
```

## 错误与重试

- 子进程退出：workflow 故障 → 无限重拉（带退避），连续失败 > 10 次升级错误日志级别；
- 单行解析 / 校验失败：连接器缺陷 → 错误日志（含原文行），跳过该行；
- sender 失败：重试 2 次 → 记日志放弃（M0），不影响 run 状态。

## 暂不做

| 项 | 回归时机 |
|---|---|
| **事件落盘（崩溃不丢 + raw_ref 审计）** | 需要可靠性时（M1+）；接口已预留——translate 与队列均不感知事件来自管道还是文件 |
| 卡片（ask / 进度更新） | M1 |
| charts 发送（需 image 上传） | M1 |
| card.action.trigger 订阅 | M1 |
| 附件 / 图片入站 | M2+ |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 事件获取形态**~~ ✅ stdout 管道直读，M0 不落盘（见 listener 节）。
- ~~**Q2 翻译归属**~~ ✅ 随 Q1 消解：事件直接流进 gateway 进程，translate 在 listener 读流处调用，产物经 `onEnvelope` 递交 core。
- ~~**Q3 M0 回复形态**~~ ✅ markdown：summary + 表格，charts 推 M1。
- ~~**Q4 断线丢事件**~~ ✅ M0 接受丢失（与不落盘的整体崩溃语义一致，用户已确认）；飞书重连窗口是否重推待联调实测，结论补录于此：＿＿＿。

## 验收标准

- kill lark-cli 子进程，listener 自动退避重拉并恢复收消息；
- 给机器人发一条私聊消息，listener 产出过 schema 校验的 Envelope 并回调 `onEnvelope`；机器人自己的消息回显被过滤；构造一行非法 NDJSON，被记日志跳过且流不中断；
- sender 能向同一 thread 回 markdown 结果；lark-cli 退出码非零时按重试语义执行；
- 全模块代码中不出现任何业务词汇（QueryIntent、dashboard 等）——纯翻译层的字面验证。
