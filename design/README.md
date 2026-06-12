# 模块设计文档索引

> 工作方式：架构级结论在 PRODUCT.md / ARCHITECTURE.md；每个模块聊透后沉淀一份设计文档到本目录；实现严格按已定稿文档推进。

## 状态约定

- 🗣 讨论中 —— 有草案，开放问题未关闭
- ✅ 已定稿 —— 开放问题全部关闭，可以照此实现
- 🚢 已实现 —— 代码落地并对照文档验收

## 模块清单（按依赖序）

| # | 模块 | 文档 | 状态 | 里程碑 |
|---|---|---|---|---|
| 01 | 契约三件套（Envelope / Task / TaskEvent） | [01-contracts.md](01-contracts.md) | 🚢 已实现 | M0 |
| 02 | lark 连接器（listener + sender） | [02-connector-lark.md](02-connector-lark.md) | 🚢 已实现（验收待联调） | M0 |
| 03 | core · queue（内存队列与幂等） | [03-core-queue.md](03-core-queue.md) | 🚢 已实现 | M0 |
| 04 | core · sessions（会话映射与 run 状态） | [04-core-sessions.md](04-core-sessions.md) | 🚢 已实现 | M0 |
| 05 | core · runtime（agent 托管与出站转发） | [05-core-runtime.md](05-core-runtime.md) | 🚢 已实现 | M0 |
| 06 | data-analysis runner（能力薄壳） | [06-capability-data-analysis.md](06-capability-data-analysis.md) | 🚢 已实现（验收待联调） | M0 |
| 07 | service（进程编排：启动 / 退出 / 自愈） | [07-service.md](07-service.md) | 🚢 已实现（验收待联调） | M0 |

> 实现：[`../service-gateway/`](../service-gateway/)（27 个单元测试全过 + 进程级冒烟）。01/03/04/05 的验收标准已由单测覆盖。**M0 联调（2026-06-12）：①② 已完成**——真实飞书一问一答端到端跑通（「昨天 DAU 多少」→ 真实数据回答，回执 + 节流进度 + thread 内回复）。联调修复记录：lark-cli 显式 `--as bot`、npx 误拉同名废弃包（改本地适配器）、异步异常崩进程（加兜底）、CLAUDECODE 嵌套检查剥离、网关簿记移 `.gateway/`（agent 会覆写 run 根目录同名文件）、最终回复取最后一个工具调用后的消息段、**DataFinder 签名修复（v4→ak-v1，能力侧根因）**。待办：③ 02-Q4 断线重推实测 → ④ launchd 部署。
| 08 | gate 挂起恢复 | 08-gate-resume.md | 未开始 | M1 |
| 09 | 身份与权限（principals） | 09-principals.md | 未开始 | M1 |

## 模块文档模板

每份文档统一结构：

```
# NN-模块名
状态：🗣 讨论中 | ✅ 已定稿 | 🚢 已实现

## 职责与边界        # 一句话职责；明确「不做什么」
## 依赖              # 依赖哪些模块 / 外部工具
## 接口与数据结构     # 对外暴露的类型、函数签名、文件格式
## 关键流程          # 正常路径 + 关键分支
## 错误与重试        # 失败语义（workflow 失败 vs LLM 质量问题）
## 暂不做            # 显式砍掉的范围 + 回归里程碑
## 开放问题          # 待讨论项；定稿时必须清空
## 验收标准          # 实现完成的可验证判据
```
