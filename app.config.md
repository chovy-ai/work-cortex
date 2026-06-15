# 接入配置说明（app.config.json）

把一个**新应用**接入 data-analysis 分析链路，只需要改两处本地文件（都不提交 git）：

| 文件 | 放什么 | git |
| --- | --- | --- |
| `app.config.json` | 非密的结构化配置：应用名、repo 地址、源码目录、产物路径 | ❌ 本地用，已 gitignore |
| `.env.local` | 密钥/凭据：DataFinder AK/SK、app_id、region 等 | ❌ 本地用，已 gitignore |

仓库里提交的是两份**通用占位模板**，clone 下来 `cp` 一份再填真值即可：

```bash
cp app.config.example.json app.config.json   # 结构化配置
cp .env.local.example      .env.local        # 凭据
```

代码（`domains/event-knowledge/extract_events`、`domains/metric-semantics/extract_data_model`、
`domains/knowledge-update/check_freshness`、`domains/event-knowledge/sync_app.sh`）都通过
[`domains/app-config/config.ts`](domains/app-config/config.ts) 这个加载器读取 `app.config.json`，
不再各自硬编码任何应用的路径，所以**接入新应用时不用改这些脚本**。

---

## 一、`app.config.json` 字段说明

下面用真实 monorepo 的填法举例（占位模板 [`app.config.example.json`](app.config.example.json) 里是 `your-app` / `path/to/...`）：

```jsonc
{
  "app": {
    "name": "your-app",                          // 被分析应用名，用于日志/产物标识
    "repo": {
      "url": "https://github.com/your-org/your-app", // sync 脚本在本地缺失时用它 clone
      "localPath": "../your-app"                  // 应用 monorepo 的本地路径；
                                                  //   相对路径相对 data-analysis 根解析
    }
  },

  "sources": {                                    // 以下路径都【相对应用 repo 根】
    "events": {                                   // 给 extract_events 用：事件目录抽取
      "tsReporters":   "path/to/analytics/reporters",
                                                  //   每个事件一个子目录，含 types.ts(参数) + *Reporter.ts(事件名)
      "goEvents":      "path/to/reporter/events", //   后端 Go 事件，每事件一个 event.go
      "mainAnalytics": "path/to/main-process/analytics", // 主进程 *Analytics.ts 调用点
      "scope": {                                  //   反向符号索引扫描的顶层目录
        "ts": ["apps", "packages"],               //     TS：哪几个顶层目录里找 reporter 引用
        "go": ["services", "packages", "apps"]    //     Go：哪几个顶层目录里找 event import
      }
    },
    "dataModel": {                                // 给 extract_data_model 用：数据模型抽取
      "defaults":    "path/to/app.defaults.json",            // 应用埋点默认值(appId/appName/channel…)
      "reporter":    "path/to/reporter/tea_reporter.go",     // 公共/剥离参数
      "trackingDoc": "path/to/analytics-tracking.md"         // 埋点架构参考文档
    }
  },

  "output": {                                     // 生成产物落盘路径，【相对 data-analysis 根】
    "eventCatalog": "knowledge-store/event-catalog.json",
    "dataModel":    "knowledge-store/data-model.json"
  }
}
```

### 路径解析规则
- `sources.*` 下的所有路径 = **应用 repo 根 + 该相对路径**。
- `output.*` 下的路径 = **data-analysis 根 + 该相对路径**。
- `app.repo.localPath` 为相对路径时相对 data-analysis 根；也可填绝对路径或 `~/…`。

### 本地路径的覆盖优先级
解析被分析应用 repo 的实际位置时，按以下顺序取第一个命中的：
1. 命令行 `--app-path <PATH>`（extract 脚本支持）
2. 环境变量 `APP_REPO_PATH`
3. `app.config.json` 的 `app.repo.localPath`

---

## 二、AK/SK 等凭据（`.env.local`，单独放）

**为什么不进 `app.config.json`**：凭据是密钥，绝不能进版本库。和结构化配置一样走
「**可提交的模板 + 本地真值**」：

- [`.env.local.example`](.env.local.example) —— 占位模板，**提交 git**，告诉接入者要填哪些 key。
- `.env.local` —— 你本地复制后填真值，**已被 `.gitignore` 忽略**，不会泄露。

```bash
cp .env.local.example .env.local   # 然后编辑 .env.local 填入真实 AK/SK
```

密钥由 `domains/datafinder-interface/client.ts` 的 `loadConfigFromEnv()` 读取。
**必填 4 项**：`DATAFINDER_BASE_URL` / `DATAFINDER_ACCESS_KEY`(AK) / `DATAFINDER_SECRET_KEY`(SK) /
`DATAFINDER_APP_ID`；`REGION`/`SERVICE` 有默认；其余（`PROJECT_ID` / `DASHBOARD_ID` /
`EVENT_ANALYSIS_ID` / `INGEST_BASE_URL` / `ENVIRONMENT`）按用到的链路补。完整清单见模板文件。

---

## 三、接入一个新应用：步骤

1. **拷模板**：`cp app.config.example.json app.config.json` 与 `cp .env.local.example .env.local`。
2. **填 `app.config.json`**：改 `app.name`、`app.repo.{url,localPath}`，再把 `sources.*`
   指到你应用 monorepo 里对应的埋点源码目录（TS reporters / Go events / 主进程 / 埋点默认值）。
3. **填凭据**：编辑 `.env.local`，填入你那套 DataFinder 的 AK/SK/app_id。
4. **拉源码**：`bash domains/event-knowledge/sync_app.sh`（本地无 repo 时按 `app.repo.url` clone）。
5. **生成知识**：`npm run build:tools` 后
   - `node build/domains/event-knowledge/extract_events.js` → `knowledge-store/event-catalog.json`
   - `node build/domains/metric-semantics/extract_data_model.js` → `knowledge-store/data-model.json`
6. **校验新鲜度**：`node build/domains/knowledge-update/check_freshness.js event-knowledge`。
