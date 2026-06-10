# 改造清单

> 从当前 `skills/nextop-data-analytics/` 平铺结构迁移到 ARCHITECTURE.md 定义的六领域目标结构的全部改造点。
> 每一条标明：类型 / 当前位置 → 目标位置 / 改动内容 / 所属阶段 / 前置依赖。
>
> 类型标记：[移] 移动文件  [新] 新建文件  [改] 修改内容  [删] 删除  [补] 补闭环能力

---

## P1 — 搭骨架：module.json 契约 + 控制平面入口

> 目标：把更新链路的接口先立起来，不改任何查询链路逻辑。

### [新] 三个知识域各补一份 module.json

**① 代码事件知识域**
```
新建 domains/event-knowledge/module.json
```
```json
{
  "id": "event-knowledge",
  "description": "nextop 事件目录（名称/参数/上报时机）",
  "truth_source": "nextop 源码 github.com/nextop-os/nextop",
  "serves": ["knowledge-store/event-catalog.json"],
  "update": {
    "type": "script",
    "cmd": "bash domains/event-knowledge/sync_nextop.sh && python3 domains/event-knowledge/extract_events.py"
  },
  "check": {
    "type": "script",
    "cmd": "python3 domains/knowledge-update/check_freshness.py event-knowledge",
    "stale_after_hours": 24
  },
  "doc_links": []
}
```

**② DataFinder 接口域**
```
新建 domains/datafinder-interface/module.json
```
```json
{
  "id": "datafinder-interface",
  "description": "DataFinder OpenAPI 端点定义 + 文档链接",
  "truth_source": "火山引擎官方文档 https://www.volcengine.com/docs/84129",
  "serves": ["domains/datafinder-interface/manifest.json"],
  "update": {
    "type": "agent",
    "procedure": "domains/datafinder-interface/UPDATE.md"
  },
  "check": {
    "type": "script",
    "cmd": "python3 domains/knowledge-update/check_freshness.py datafinder-interface",
    "stale_signal": "manifest 中 path_verified=false 数量 > 0 或 last_verified_against_docs_at 超过 30 天"
  },
  "doc_links": [
    "https://www.volcengine.com/docs/84129",
    "https://www.volcengine.com/docs/84129/1261794?lang=zh",
    "https://www.volcengine.com/docs/84129/1563654"
  ]
}
```

**③ 口径语义域**
```
新建 domains/metric-semantics/module.json
```
```json
{
  "id": "metric-semantics",
  "description": "DAU口径/身份键/nextopd公共参数/默认指标定义",
  "truth_source": "nextop 源码（tea_reporter.go + nextop.defaults.json）",
  "serves": ["knowledge-store/data-model.json"],
  "update": {
    "type": "script",
    "cmd": "python3 domains/metric-semantics/extract_data_model.py"
  },
  "check": {
    "type": "script",
    "cmd": "python3 domains/knowledge-update/check_freshness.py metric-semantics",
    "stale_after_hours": 24
  },
  "doc_links": []
}
```

---

### [新] ④ update_knowledge.py — 控制平面骨架

```
新建 domains/knowledge-update/update_knowledge.py
```

实现三个命令：

| 命令 | 行为 |
|---|---|
| `status` | 扫描所有 `domains/*/module.json`，对每个模块跑 `check`，输出 fresh / stale / unknown |
| `update <id\|all>` | `type=script` → 直接跑 `cmd`；`type=agent` → 打印「更新指令 + doc_links」，交给 Agent 走 UPDATE.md |
| `register` | 重新扫描 `domains/*/module.json`，更新已知模块列表 |

```bash
# 用法
python3 domains/knowledge-update/update_knowledge.py status
python3 domains/knowledge-update/update_knowledge.py update event-knowledge
python3 domains/knowledge-update/update_knowledge.py update all
```

---

### [新] 创建 knowledge-store/ 目录

```
新建 knowledge-store/.gitkeep
新建 knowledge-store/data-model.json    ← 占位，③ 产出后覆盖
```

---

### [改] .gitignore — 更新忽略路径

```diff
- skills/nextop-data-analytics/references/common/nextop-event-catalog.json
+ knowledge-store/event-catalog.json
+ knowledge-store/data-model.json
+ outputs/
```

---

## P2 — 目录迁移：现有文件搬到领域目录

> 目标：物理目录与领域模型对齐。每次移动后同步更新引用路径。
> 移动顺序：先工具脚本 → 再协议文档 → 再删旧目录。

### [移] ① 代码事件知识域

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/tools/sync_nextop.sh` | `domains/event-knowledge/sync_nextop.sh` |
| `skills/nextop-data-analytics/tools/extract_events.py` | `domains/event-knowledge/extract_events.py` |

移动后需修复的路径依赖（见 P2-FIX-1）。

---

### [移] ② DataFinder 接口域

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/tools/datafinder/__init__.py` | `domains/datafinder-interface/__init__.py` |
| `skills/nextop-data-analytics/tools/datafinder/client.py` | `domains/datafinder-interface/client.py` |
| `skills/nextop-data-analytics/tools/datafinder/cli.py` | `domains/datafinder-interface/cli.py` |
| `skills/nextop-data-analytics/tools/datafinder/manifest.json` | `domains/datafinder-interface/manifest.json` |
| `skills/nextop-data-analytics/tools/datafinder/UPDATE.md` | `domains/datafinder-interface/UPDATE.md` |
| `skills/nextop-data-analytics/tools/datafinder/README.md` | `domains/datafinder-interface/README.md` |
| `skills/nextop-data-analytics/references/common/volcengine-openapi-capabilities.md` | `domains/datafinder-interface/openapi-routing.md` ← 降级为补充说明，主路由已在 manifest |

移动后需修复的路径依赖（见 P2-FIX-2）。

---

### [移] ③ 口径语义域

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/references/common/nextop-analytics-data-model.md` | `domains/metric-semantics/data-model-protocol.md` |

---

### [移] ⑤ 意图路由域

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/references/common/capabilities.json` | `domains/intent-routing/capabilities.json` |
| `skills/nextop-data-analytics/references/common/capability-inventory.md` | `domains/intent-routing/capability-inventory.md` |
| `skills/nextop-data-analytics/references/common/query-intent-protocol.md` | `domains/intent-routing/query-intent-protocol.md` |
| `skills/nextop-data-analytics/references/common/query-intent.schema.json` | `domains/intent-routing/query-intent.schema.json` |

---

### [移] ⑥ 查询执行域 — 执行器

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/tools/kafka_executor.py` | `domains/query-execution/executors/kafka_executor.py` |
| `skills/nextop-data-analytics/tools/local_executor.py` | `domains/query-execution/executors/local_executor.py` |

---

### [移] ⑥ 查询执行域 — 协议文档

| 从 | 到 |
|---|---|
| `references/dashboard/query-plan-protocol.md` | `domains/query-execution/protocols/dashboard/query-plan-protocol.md` |
| `references/dashboard/compiled-query-protocol.md` | `domains/query-execution/protocols/dashboard/compiled-query-protocol.md` |
| `references/dashboard/execution-result-protocol.md` | `domains/query-execution/protocols/dashboard/execution-result-protocol.md` |
| `references/raw_analysis/query-plan-protocol.md` | `domains/query-execution/protocols/raw-analysis/query-plan-protocol.md` |
| `references/raw_analysis/query-plan.schema.json` | `domains/query-execution/protocols/raw-analysis/query-plan.schema.json` |
| `references/raw_analysis/compiled-query-protocol.md` | `domains/query-execution/protocols/raw-analysis/compiled-query-protocol.md` |
| `references/raw_analysis/compiled-query.schema.json` | `domains/query-execution/protocols/raw-analysis/compiled-query.schema.json` |
| `references/raw_analysis/execution-result-protocol.md` | `domains/query-execution/protocols/raw-analysis/execution-result-protocol.md` |
| `references/raw_analysis/execution-result.schema.json` | `domains/query-execution/protocols/raw-analysis/execution-result.schema.json` |
| `references/raw_analysis/review-protocol.md` | `domains/query-execution/protocols/raw-analysis/review-protocol.md` |
| `references/raw_analysis/datafinder-kafka-raw-events.md` | `domains/query-execution/protocols/raw-analysis/datafinder-kafka-raw-events.md` |

---

### [移] knowledge-store — 事件目录产物

| 从 | 到 |
|---|---|
| `skills/nextop-data-analytics/references/common/nextop-event-catalog.json` | `knowledge-store/event-catalog.json` |

---

### [删] 迁移完成后清理

```
删除 skills/nextop-data-analytics/tools/datafinder_client.py     ← backward-compat shim，迁移后无需
删除 skills/nextop-data-analytics/tools/                          ← 迁移完后为空
删除 skills/nextop-data-analytics/references/                     ← 迁移完后为空
删除 skills/nextop-data-analytics/ARCHITECTURE.md                 ← 已被根目录 ARCHITECTURE.md 取代
删除 skills/nextop-data-analytics/DOMAIN-DESIGN.md                ← 内容已合入 ARCHITECTURE.md
删除 skills/nextop-data-analytics/EXECUTION-FLOW.md               ← 内容已合入 ARCHITECTURE.md
```

---

## P2-FIX — 路径依赖修复（随迁移同步执行）

### P2-FIX-1：extract_events.py 路径修复

移动到 `domains/event-knowledge/extract_events.py` 后，以下硬编码失效：

```python
# 当前（相对 tools/ 目录）
SKILL_ROOT = HERE.parent                                    # → skills/nextop-data-analytics/
NEXTOP_DEFAULT = (HERE / "../../../../nextop").resolve()    # → Desktop/team-shell/nextop
OUTPUT_FILE = SKILL_ROOT / "references" / "common" / "nextop-event-catalog.json"
```

改为（相对 `domains/event-knowledge/`）：

```python
REPO_ROOT = HERE.parent.parent.parent                       # → data-analysis/
NEXTOP_DEFAULT = (REPO_ROOT.parent / "nextop").resolve()    # → Desktop/team-shell/nextop（不变）
OUTPUT_FILE = REPO_ROOT / "knowledge-store" / "event-catalog.json"
```

---

### P2-FIX-2：datafinder client.py 路径修复

移动到 `domains/datafinder-interface/client.py` 后，.env.local 的相对深度变化：

```python
# 当前（skills/nextop-data-analytics/tools/datafinder/client.py，4层上）
path = Path(__file__).parents[4] / ".env.local"

# 目标（domains/datafinder-interface/client.py，2层上）
path = Path(__file__).parents[2] / ".env.local"
```

---

### P2-FIX-3：SKILL.md 路径引用全量更新

SKILL.md 中所有旧路径改为新路径：

| 旧引用 | 新引用 |
|---|---|
| `bash tools/sync_nextop.sh` | `bash domains/event-knowledge/sync_nextop.sh` |
| `python3 tools/extract_events.py` | `python3 domains/event-knowledge/extract_events.py` |
| `references/common/nextop-event-catalog.json` | `knowledge-store/event-catalog.json` |
| `tools/datafinder/` | `domains/datafinder-interface/` |
| `tools/datafinder/UPDATE.md` | `domains/datafinder-interface/UPDATE.md` |
| `tools/datafinder/README.md` | `domains/datafinder-interface/README.md` |
| `references/common/volcengine-openapi-capabilities.md` | `domains/datafinder-interface/openapi-routing.md` |
| `references/raw_analysis/datafinder-kafka-raw-events.md` | `domains/query-execution/protocols/raw-analysis/datafinder-kafka-raw-events.md` |
| `references/raw_analysis/review-protocol.md` | `domains/query-execution/protocols/raw-analysis/review-protocol.md` |
| `references/dashboard/…` | `domains/query-execution/protocols/dashboard/…` |
| `references/raw_analysis/…-protocol.md` | `domains/query-execution/protocols/raw-analysis/…-protocol.md` |
| `references/common/nextop-analytics-data-model.md` | `domains/metric-semantics/data-model-protocol.md` |
| `references/common/query-intent-protocol.md` | `domains/intent-routing/query-intent-protocol.md` |
| `references/common/capabilities.json` | `domains/intent-routing/capabilities.json` |

---

### P2-FIX-4：manifest.json 全量端点验证

当前状态：**16/16 端点 `path_verified=false`**（均为推断路径，未对照文档）。

逐条执行 `domains/datafinder-interface/UPDATE.md` 中的验证流程：
WebFetch 对应文档页面 → 确认 method/path/参数 → 改 `path_verified: true` + 更新 `last_verified_against_docs_at`。

优先级（按查询链路使用频率）：

| 优先级 | 端点 | 文档 URL |
|---|---|---|
| P0（最先） | `dashboard.list` | https://www.volcengine.com/docs/84129/1285218 |
| P0 | `report.query` | https://www.volcengine.com/docs/84129/1285240 |
| P0 | `analysis.query` | https://www.volcengine.com/docs/84129/1285232 |
| P0 | `analysis.result` | https://www.volcengine.com/docs/84129/1285232 |
| P1 | `metadata.query` | https://www.volcengine.com/docs/84129/1285232 |
| P1 | `user.profile` | https://www.volcengine.com/docs/84129/1285261 |
| P1 | `user.behavior_flow` | https://www.volcengine.com/docs/84129/1285271 |
| P2 | `analysis.download` | https://www.volcengine.com/docs/84129/1285237 |
| P2 | `dashboard.reports` | https://www.volcengine.com/docs/84129/1285218 |
| P2 | `user.query_create/result` | https://www.volcengine.com/docs/84129/1285291 |
| P3 | `segment.query` `tag.v1/v2` `raw_event.export` `usage.stats` | 各对应文档 |

---

## P3 — ⑥ 查询执行调度器

> 目标：把查询链路的 if/else 流程形式化成声明式状态机，每个 step 只返回 StepOutcome。

### [新] workflow.json — 声明式 step 图

```
新建 domains/query-execution/scheduler/workflow.json
```

内容：steps 数组（id/kind/run） + edges（正向推进） + backEdges（允许的打回 + maxRevisions）。

### [新] scheduler.py — 通用调度循环

```
新建 domains/query-execution/scheduler/scheduler.py
```

实现：`while running` 循环 + StepOutcome 分支 + `revisions` 计数 + `await_input` 挂起 + `persist/resume`。

### [新] steps/ — 各步骤薄封装

每个 step 的 `run(ctx) → StepOutcome`，内部调用现有协议逻辑，不重写业务逻辑。

```
新建 domains/query-execution/steps/understand.py         # S1: NL → QueryIntent
新建 domains/query-execution/steps/route.py              # S2: 按 query_path 分叉

新建 domains/query-execution/steps/dashboard/resolve.py  # 4A
新建 domains/query-execution/steps/dashboard/plan.py     # 5A
新建 domains/query-execution/steps/dashboard/compile.py  # 6A
新建 domains/query-execution/steps/dashboard/execute.py  # 7A
新建 domains/query-execution/steps/dashboard/report.py   # 8A

新建 domains/query-execution/steps/raw-analysis/prepare.py      # 4B-5B
新建 domains/query-execution/steps/raw-analysis/auto_review.py  # 6B [gate]
新建 domains/query-execution/steps/raw-analysis/user_review.py  # 7B [human_gate]
新建 domains/query-execution/steps/raw-analysis/plan.py         # 8B
新建 domains/query-execution/steps/raw-analysis/compile.py      # 9B
新建 domains/query-execution/steps/raw-analysis/execute.py      # 10B
新建 domains/query-execution/steps/raw-analysis/validate.py     # 11B [gate]
新建 domains/query-execution/steps/raw-analysis/report.py       # 输出
```

### [新] outputs/ — 运行状态持久化

```
新建 outputs/.gitkeep
```

每次运行写 `outputs/<run_id>/state.json`（调度器当前状态，支持挂起恢复和审计回放）。

---

## P4 — 补闭环：待建能力

### [补] ③ 口径语义域 extract_data_model.py

```
新建 domains/metric-semantics/extract_data_model.py
```

从 nextop 仓库提取并写入 `knowledge-store/data-model.json`：

| 提取来源 | 提取内容 |
|---|---|
| `config/nextop.defaults.json` | appId、appName、channel domain |
| `services/nextopd/service/reporter/tea_reporter.go` | nextopd 注入的公共参数（device_id / session_id / app_version / os）；被 nextopd 剥除的 renderer 参数 |
| `docs/architecture/analytics-tracking.md` | 上报链路描述 |

完成后 `domains/metric-semantics/data-model-protocol.md` 降格为人读说明，`knowledge-store/data-model.json` 成为机读真相源。

---

### [补] ⑤ capabilities.json 派生校验

当前 `capabilities.json` 手写维护，与 `manifest.json` 各维护一份端点清单，容易不同步。

目标：写一个 `check_capabilities_sync.py`，对比 `manifest.json` 的端点 id 与 `capabilities.json` 的 `capability_id`，发现缺失/多余时报警。不要求完全自动生成（能力语义需人工决策），只要校验同步即可。

```
新建 domains/knowledge-update/check_capabilities_sync.py
```

---

### [补] ④ check_freshness.py — 新鲜度检查

`update_knowledge.py status` 需调用各域的 check 命令。统一实现：

```
新建 domains/knowledge-update/check_freshness.py
```

| 模块 | 新鲜度判断逻辑 |
|---|---|
| `event-knowledge` | 比对 `knowledge-store/event-catalog.json` 中的 `nextop_commit` vs `git ls-remote origin HEAD` |
| `datafinder-interface` | 统计 `manifest.json` 中 `path_verified=false` 数量 + `last_verified_against_docs_at` 距今天数 |
| `metric-semantics` | 比对 `knowledge-store/data-model.json` 中的 `nextop_commit` vs `git ls-remote origin HEAD` |

---

## 全量改造点汇总

| # | 类型 | 项目 | 阶段 | 状态 |
|---|---|---|---|---|
| 1 | [新] | `domains/event-knowledge/module.json` | P1 | 待建 |
| 2 | [新] | `domains/datafinder-interface/module.json` | P1 | 待建 |
| 3 | [新] | `domains/metric-semantics/module.json` | P1 | 待建 |
| 4 | [新] | `domains/knowledge-update/update_knowledge.py` | P1 | 待建 |
| 5 | [新] | `knowledge-store/` 目录 + .gitkeep | P1 | 待建 |
| 6 | [改] | `.gitignore` 更新忽略路径 | P1 | 待改 |
| 7 | [移] | `tools/sync_nextop.sh` → `domains/event-knowledge/` | P2 | 待移 |
| 8 | [移] | `tools/extract_events.py` → `domains/event-knowledge/` | P2 | 待移 |
| 9 | [移] | `tools/datafinder/` → `domains/datafinder-interface/` | P2 | 待移 |
| 10 | [移] | `tools/kafka_executor.py` → `domains/query-execution/executors/` | P2 | 待移 |
| 11 | [移] | `tools/local_executor.py` → `domains/query-execution/executors/` | P2 | 待移 |
| 12 | [移] | `references/common/capabilities.json` + 3 个 intent 文件 → `domains/intent-routing/` | P2 | 待移 |
| 13 | [移] | `references/common/nextop-analytics-data-model.md` → `domains/metric-semantics/` | P2 | 待移 |
| 14 | [移] | `references/common/volcengine-openapi-capabilities.md` → `domains/datafinder-interface/` | P2 | 待移 |
| 15 | [移] | `references/dashboard/` 3 文件 → `domains/query-execution/protocols/dashboard/` | P2 | 待移 |
| 16 | [移] | `references/raw_analysis/` 8 文件 → `domains/query-execution/protocols/raw-analysis/` | P2 | 待移 |
| 17 | [移] | `references/common/nextop-event-catalog.json` → `knowledge-store/event-catalog.json` | P2 | 待移 |
| 18 | [改] | `extract_events.py` 修复 OUTPUT_FILE / NEXTOP_DEFAULT 路径 | P2-FIX | 待改 |
| 19 | [改] | `client.py` 修复 .env.local 相对深度（parents[4]→parents[2]）| P2-FIX | 待改 |
| 20 | [改] | `SKILL.md` 全量路径引用更新（14 处） | P2-FIX | 待改 |
| 21 | [改] | `manifest.json` 16 个端点逐条验证（path_verified=false→true） | P2-FIX | 待验 |
| 22 | [删] | `tools/datafinder_client.py` backward-compat shim | P2 | 待删 |
| 23 | [删] | `skills/nextop-data-analytics/ARCHITECTURE.md` `DOMAIN-DESIGN.md` `EXECUTION-FLOW.md` | P2 | 待删 |
| 24 | [新] | `domains/query-execution/scheduler/workflow.json` | P3 | 待建 |
| 25 | [新] | `domains/query-execution/scheduler/scheduler.py` | P3 | 待建 |
| 26 | [新] | `domains/query-execution/steps/understand.py` + `route.py` | P3 | 待建 |
| 27 | [新] | `domains/query-execution/steps/dashboard/` 5 个 step | P3 | 待建 |
| 28 | [新] | `domains/query-execution/steps/raw-analysis/` 8 个 step | P3 | 待建 |
| 29 | [新] | `outputs/.gitkeep` | P3 | 待建 |
| 30 | [补] | `domains/metric-semantics/extract_data_model.py` | P4 | 待建 |
| 31 | [补] | `domains/knowledge-update/check_freshness.py` | P4 | 待建 |
| 32 | [补] | `domains/knowledge-update/check_capabilities_sync.py` | P4 | 待建 |

**合计：新建 17 个、移动 11 批、修改 5 处、删除 5 个、待补能力 3 个 = 共 32 项**
