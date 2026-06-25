---
name: data-analytics
description: Query and analyze 火山引擎 DataFinder product analytics. Two capabilities — reuse existing dashboards/reports (DAU/PV/UV/retention/funnel saved charts), and free-form event analysis (custom metric/breakdown over events). Use when users ask for application metrics, growth/retention/funnel numbers, feature usage, or "why did metric X move".
---

# Data Analytics

把自然语言分析诉求变成 **火山引擎 DataFinder** 调用并出数。两种能力：

- **能力 A — 看板复用（dashboard）**：复用 DataFinder 里已建好的看板/报表（口径由资产自身定义，最稳）。**当前可用** ✅
- **能力 B — 自由分析（free analysis）**：对事件自定义指标/拆分，构造 analysis DSL 查询。**当前可用** ✅

## 决策顺序（必读，强制）

**永远优先能力 A（看板复用），自由分析只是兜底。** 每条指标问题按此走：

1. **先查已有报表**：`call dashboard.list` → 对相关看板 `call dashboard.reports`，看是否有能直接回答该问题的报表（按报表名/指标语义匹配，如 PV/UV/DAU/留存/漏斗）。
2. **命中 → 用能力 A 出数（report.query），到此为止**：不要再做自由分析，不要"顺手"查相邻事件/指标，不要给用户没问的额外数据。
3. **仅当确认没有任何可用报表** → 才用能力 B（自由分析）构造 DSL。在回复里说明"无现成报表，已用自由分析"。
4. **不过度探索**：只回答用户问的那个问题，用最短路径；省下的每一步都更快。

所有 DataFinder 调用都经独立 SDK 包 `@workcortex/datafinder-sdk`（manifest 驱动、自描述、每端点带官方文档链接）。凭据在 ability 根的 `.env.local`，由适配层 `domains/datafinder-interface/index.js` 注入。

> 历史：旧的 query-execution 声明式调度链路（understand→route→prepare→review→…）已**移除**，因为它未经验证、且 analysis.query 实测 400。现在是 skill 驱动 + SDK 直调，逐能力验证打磨。

## 工具入口（agent 用）

DataFinder CLI（SDK 支撑，发现无需凭据，调用读 `.env.local`）：

```
# 发现接口（带官方文档链接）
node build/domains/datafinder-interface/cli.js list                # 16 个端点 + 摘要
node build/domains/datafinder-interface/cli.js describe report.query  # 单端点完整 spec + doc_url

# 调用（读 .env.local 凭据）
node build/domains/datafinder-interface/cli.js call dashboard.list
node build/domains/datafinder-interface/cli.js call report.query --params '{"report_id":"…","count":10}'
```

（缺 `build/` 先在仓库根 `npm run build:ability`。）

程序化用法：`import { dataFinder } from "domains/datafinder-interface/index.js"` → `dataFinder().reports.query({ report_id, count })` / `dataFinder().call(id, params)`；或直接 `@workcortex/datafinder-sdk` 的 `createDataFinderSDK(loadConfigFromEnv(envPath))`。结果统一为 `DfResult`（成功带 `result` 表格/记录，失败带 `code`/`message`/`docUrl`）。

接口缺失/路径未验证：`call` 未知 id 返回 `endpoint_not_in_manifest`；按 `packages/datafinder-sdk/UPDATE.md` 照官方文档扩 `packages/datafinder-sdk/manifest.json`。新鲜度自检：`npm run check:freshness -w @workcortex/datafinder-sdk`。

## 能力 A — 看板复用（dashboard）✅

适用：用户要的是已有看板/报表里的指标（DAU/PV/UV/留存/漏斗等已沉淀的图），或给了 `report_id`/`dashboard_id`。口径由资产自身定义，无需自己造 DSL，最稳。

1. **找资产**：`call dashboard.list` 列看板（含 `dashboard_id`、`app_id`、名称）→ `call dashboard.reports --params '{"dashboard_id":"…"}'` 列报表，拿到目标 `report_id`（按名称匹配，如 "PV & UV"）。
2. **取数**：`call report.query --params '{"report_id":"…","count":N}'`。真实数据在 `data.dsls[0].data[].data_item_list[]`（每指标一组时间序列，配 `date_index_list`）。SDK/适配层会把它归一化成「date × 各指标」表格。
3. **解读**：报出资产名、时间范围、各指标数值与口径说明（口径属于资产）。

实测：报表 PV&UV（`7649241423115461888`）能稳定返回真实 PV/UV 日序列。

## 能力 B — 自由分析（free analysis）✅

适用：用户要自定义指标/事件集/拆分维度，没有现成报表能直接答（如"按 provider 拆分某事件的近 7 天人数"）。

1. **接地事件**：先有事件目录（见 Phase 0）。只用目录里真实存在的 `event_name`/`params`，不要臆造。
2. **构造 DSL**：analysis DSL 结构复杂——**最稳的起手式是借一个相近报表的 `dsl_content` 当模板**：`call report.query`（返回里含该报表的 `dsl_content`），照它改 `periods`（时间/粒度）与 `content.queries`（事件+指标：`event_indicator` 取 `events`=次数 / `event_users`=人数；`event_name` 用真实事件名，如页面访问是 `predefine_pageview`）。`resources`/`version` 沿用模板。
3. **执行**：`call analysis.query --params '<DSL>'`。

> **请求契约（关键，易错）**：analysis.query 的请求体 = **DSL 字段（`periods`/`content`/`resources`/`version`…）直接铺在顶层**，**不要**包成 `{"dsl":{...}}`。报表的 `dsl_content` 本身就是这个形状，可直接当 params。范围参数 `app_ids`（或 `project_ids`）由 cli/SDK 从 `.env.local` 自动注入，无需手填（要覆盖则显式传 `app_ids`/`project_ids`）。
>
> 真因排查：若报 `code=400`，看 SDK 错误里带出的 `errors`（如 `app_ids or project_ids must be provided`、`缺少某些字段 'periods'`）——那才是真原因。实测：用报表 `dsl_content` 直发 analysis.query 可稳定返回真实日序列。

## Phase 0 — 事件目录（自由分析的接地，按需刷新）

1. 拉应用源码：`bash domains/event-knowledge/sync_app.sh`（用户确认本地最新可跳过）。
2. 生成目录：`node build/domains/event-knowledge/extract_events.js`（缺 build 先 `npm run build:ability`）→ `knowledge-store/event-catalog.json`。
3. 读目录：每条含 `event_name` / `params` / `trigger_files`（上报时机）。这是本会话事件的权威来源，优先于 DataFinder metadata 接口。

## "为什么变了"——归因（可选）

用户问 **why**（"DAU 为什么跌"）而非 what 时，走确定性分析引擎 `domains/analysis-engine/`（数据可信度门 → 异常确认 → 贡献度分解 → 下钻），见 `domains/analysis-engine/README.md` 与 `playbooks/rca-anomaly.yaml`。引擎经 DataFinder 取数（analysis.query 已可用）。

## 默认口径

- DAU 默认 `count(distinct device_id)` 按本地日；优先事件发生时间而非入库时间。
- 聚合前先按配置的 app 过滤。
- 公共参数 `device_id`/`session_id`/`app_version`/`os` 以上报服务为准。
- 默认不排除任何事件；若用户要"有意义的活跃"，先提排除清单并说明影响再应用。

## 配置

凭据不入库，放 ability 根 `.env.local`，由适配层注入：`DATAFINDER_BASE_URL` / `DATAFINDER_ACCESS_KEY` / `DATAFINDER_SECRET_KEY` / `DATAFINDER_APP_ID`（可选 `DATAFINDER_PROJECT_ID`/`DATAFINDER_REGION`/`DATAFINDER_SERVICE`）。缺失时向用户索要。

## 输出规约

每次答复包含：数据来源与接口、指标定义/口径、时间范围与时区、过滤（尤其 `app_id`）、校验与结果注意点。需要接口细节时给官方文档链接（`describe <id>` 的 doc_url），不要把长 API 规格抄进答复。
