# 01 · 契约三件套（Envelope / Task / TaskEvent）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

定义三层之间流动的全部数据结构。契约是两道接缝的唯一形态——连接器、core、能力之间**只允许**通过这三种结构通信，跨层引用类型即架构违规。

不做：传输方式（文件 / 进程内 / 子进程）属于各模块文档；本文只定「数据长什么样」。

## 依赖

无（它是依赖树的根，所有模块依赖它）。

## 接口与数据结构

### 真相源与类型生成（✅ 已定，原 Q1）

- `core/*.schema.json`（JSON Schema draft-2020-12）是**唯一真相源**；
- 运行时校验：ajv 直接解析 schema 文件做校验——校验逻辑零手写、零生成，不存在「校验代码忘了同步」这个漂移源。Envelope 在 listener 出口校验，Task 在 core 下发前校验，TaskEvent 在 core 接收时校验——**每道接缝两端各验一次，违约就地报错**，不让脏数据穿层；
- TS 类型由 schema 生成（`json-schema-to-typescript`），生成物进 git，命令 `npm run gen:types`，CI 检查重新生成 diff 为零。类型仅服务编译期提示，运行时一律以 schema 为准。

理由：① 契约要被 TS（gateway）和 Python（能力真身）同时消费，JSON Schema 是双方原生可读的形态；② 与 ARCHITECTURE.md 既有 `query-intent.schema.json` 等「schema 即文档」做法一致；③ **对 AI 协作友好**——agent 读契约、改契约、照契约构造数据，读一个语言中立的 JSON 文件即可，无需理解任何 DSL。

### Envelope（接缝一 · 入站）

```jsonc
{
  "v": 1,                            // 契约版本，向后兼容字段只增不改义
  "event_id": "evt_xxx",             // 渠道原生事件 id
  "dedup_key": "lark:evt_xxx",       // ${channel}:${event_id}，幂等键由 listener 拼好
  "channel": "lark",
  "received_at": "2026-06-11T10:00:00Z",   // listener 收到时刻（ISO 8601 UTC）
  "conversation": {
    "id": "oc_xxx",
    "thread_id": "omt_xxx | null",
    "type": "p2p | group"
  },
  "principal": { "channel_user_id": "ou_xxx", "display_name": "…" },
  "kind": "message | action | system",
  "message": {                        // kind=message 时必填
    "text": "昨天 DAU 多少",
    "attachments": [                  // M0 不消费，形状先定
      { "type": "image | file", "ref": "file_key", "name": "…" }
    ]
  },
  "action": {                         // kind=action 时必填（gate 回调）
    "run_id": "…",
    "action_id": "confirm | revise | cancel",
    "params": {}
  },
  "raw_ref": "string | null"             // 原始事件文件指针，不内嵌（见 Q4）；M0 管道直读无落盘，恒为 null（修订 R1）
}
```

### Task（接缝二 · 下发）

```jsonc
{
  "v": 1,
  "run_id": "run_20260611_…",         // core 生成，全局唯一，同时是 outputs/<run_id>/ 目录名
  "capability": "data-analysis",
  "input": { "text": "…", "attachments": [] },
  "context": {
    "principal": { "member": "…", "roles": [] },   // M0 透传 channel_user_id，M1 接 principals
    "conversation_ref": "opaque-string",            // core 可解码、能力不可解读，原样带回
    "history": []                                   // thread 追问上文，M0 恒为空，M1 定策略
  },
  "resume": null,                      // M1：{ "action_id": "confirm", "params": {} }
  "limits": { "timeout_s": 600 }       // core 强制执行的硬上限（见 Q3）
}
```

### TaskEvent（接缝二 · 回流，流式有序）

```jsonc
{ "v": 1, "run_id": "…", "seq": 3, "at": "…", "kind": "progress", "status": "正在解析口径…" }
{ "v": 1, "run_id": "…", "seq": 4, "at": "…", "kind": "ask", "prompt": "…", "options": ["confirm","revise","cancel"] }
{ "v": 1, "run_id": "…", "seq": 5, "at": "…", "kind": "result",
  "summary": "…",                      // 一句话结论（结果四段式之一）
  "tables": [ { "title": "…", "columns": [], "rows": [] } ],
  "charts": [ { "title": "…", "image_path": "outputs/<run_id>/chart1.png" } ],
  "artifacts_dir": "outputs/<run_id>" }
{ "v": 1, "run_id": "…", "seq": 9, "kind": "error", "reason": "…", "retriable": false }
{ "v": 1, "run_id": "…", "seq": 2, "kind": "signal", "type": "knowledge_gap", "detail": {} }
```

流约束：

- `seq` 单调递增，core 据此排序与去重；
- **终态事件有且仅有一个**：`result` 或 `error`，之后流关闭；`progress` / `ask` / `signal` 是中间事件；
- 整条流持久化到 `outputs/<run_id>/events.ndjson`（审计的最小形态，M2 之前就有）。

## 关键流程

校验失败的处理（按四条规则的失败语义）：

- Envelope 校验失败 = 连接器缺陷 → 原始事件留在 inbox 标记 `invalid/`，报错日志，不阻塞后续事件；
- TaskEvent 校验失败 = runner 缺陷 → 该 run 以 error 终态收尾，用户侧收到「分析失败」。

## 暂不做

| 项 | 回归时机 |
|---|---|
| `attachments` 消费（图片提问） | M2+ |
| `history` 构造策略 | M1 |
| `resume` 处理 | M1（08-gate-resume） |
| schema 版本协商（v2 共存） | 真的需要破坏性变更时 |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 真相源**~~ ✅ JSON Schema 为源，ajv 运行时直接解析校验，TS 类型为生成物（见「接口与数据结构」）。
- ~~**Q2 runner 边界形态**~~ ✅ 不隔进程：runner 是 gateway 包内 TS 模块，core 直接 import 调用 `run(task, emit)`。签名与 NDJSON 同构（emit 的事件都是过了 schema 校验的纯数据），M3 若出现非 TS 能力，加 SubprocessRunner 适配器即可，core 不改。重活本来就在 claude headless 子进程里，薄壳同进程风险可接受。
- ~~**Q3 limits**~~ ✅ M0 只做 `timeout_s` 硬上限；token 成本先观测（events.ndjson 留痕）不控制，预算字段 M2 再加。
- ~~**Q4 raw 原文**~~ ✅ 信封只带 `raw_ref` 指向原始事件文件，不内嵌。

## 修订记录

- **R1（2026-06-12，随 02-Q1 决策）**：M0 事件走 stdout 管道直读、不落盘，`raw_ref` 类型放宽为 `string | null`，M0 恒为 null；未来启用事件落盘时回填语义不变。
- **R2（2026-06-12，随 05-Q2 决策）**：runner 签名细化为 `run(task, emit(draft), signal)`——emit 只交 `kind + 载荷`（TaskEventDraft），簿记字段 `v / run_id / seq / at` 由 runtime 单一写者补全后才构成完整 TaskEvent；`signal: AbortSignal` 用于超时/停机取消，runner 收到后负责善后自己拉起的子进程。TaskEvent 的线上形态（schema）不变。
- **R3（2026-06-12，实现期发现）**：`Envelope.conversation` 增加可选字段 `source_message_id`（string | null）——lark 的 `+messages-reply` 需要源消息 id 才能 thread 内回复；其他渠道无此概念时置 null。

## 验收标准

- 三个 schema 文件 + 生成的 TS 类型进 git，`npm run gen:types` 可重复生成且 diff 为零；
- ajv 校验在三处接缝点接通，构造一条非法 Envelope / TaskEvent 能被就地拦截并按上述失败语义处理；
- 一条合法消息可以仅靠这三种结构走完「lark 事件 → Envelope → Task → TaskEvent(result) → 回复」的纸面推演，无需任何层私下传递额外数据。
