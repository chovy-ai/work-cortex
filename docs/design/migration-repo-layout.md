# 仓库目录重整方案（Repo Layout Migration）

> 状态：**已执行（2026-06-16）**。根目录从 14 个混杂条目收敛到 6 项（4 个分层目录 + README + package.json）。
> 决策（2026-06-15）：脊柱独立成 `platform/` 层，GUI 作为脊柱客户端放 `platform/console/`。
> 验证：atomic-abilities build ✓ · ability 48/48 ✓ · service-gateway 32/32 ✓ · console cargo check ✓。
>
> 执行期修正：`gw-marks/` 实为 console 的**运行时截图输出**（`mark.rs` 写入），非文档图。
> 故 console 运行时输出改写到 console 本地 `gw-marks/`（被其 `.gitignore /gw-marks` 忽略）；
> 已提交的 `mark-1/2.png` 作为留存示例放 `docs/assets/marks/`。

---

## 一、问题诊断

根目录把**四类不同性质的东西摊平在同一层**，互不分层：

| 类别 | 现散在根级的内容 |
|---|---|
| 📄 文档 | `README.md` `PRODUCT.md` `ARCHITECTURE.md` `CHANGES.md` `app.config.md` + `design/` + `docs/superpowers/` + `gw-marks/` |
| 🖥 平台脊柱 + 客户端 | `service-gateway/`（Node 常驻进程）、`gateway-console/`（Rust GUI） |
| 🧠 分析能力本体 | `domains/` `skills/` `tests/` `knowledge-store/` `outputs/` `build/` `app.config*.json` `.env.local` + 根 `package.json/tsconfig` |
| 📦 共享库 | `atomic-abilities/`（被根 package 以 `file:` 依赖） |

> 关键事实：根级 `package.json` / `package-lock.json` / `node_modules/` / `tsconfig.tools.json` / `build/` **本身就属于"分析能力本体"**（`name: data-analysis-tools`，脚本 `build:tools`/`test:tools`）。因此它们应跟 `domains/`、`skills/` 一起收进 `abilities/data-analysis/`，新根只留极薄的 workspace 清单。

---

## 二、目标结构

```
data-analysis/                       # 仓库根（实际是 WorkCortex，目录名暂不改）
├── README.md                        # 唯一入口，保留
├── package.json                     # ✦ 新：workspace 根（platform/* abilities/* packages/*）
├── .gitignore  .env.local.example
│
├── platform/                        # ★ 整体架子（WorkCortex 脊柱 + 其客户端）
│   ├── service-gateway/             #   常驻进程本体：connectors / core / capabilities-host（Node）
│   └── console/                     #   桌面监控 GUI（Rust，现 gateway-console）
│
├── abilities/                       # 插进架子的能力
│   └── data-analysis/               #   现根级"分析本体"全部收进来
│       ├── README.md  app.config.md  app.config(.example).json  .env.local
│       ├── package.json  package-lock.json  tsconfig.tools.json
│       ├── domains/  skills/  tests/
│       ├── knowledge-store/         #   gitignored
│       ├── outputs/                 #   gitignored
│       └── build/                   #   gitignored（生成物，可删后重编）
│
├── packages/                        # 共享库
│   └── atomic-abilities/
│
└── docs/                            # 所有"给人看的"
    ├── PRODUCT.md  ARCHITECTURE.md  CHANGES.md
    ├── design/                      # 现 design/（01–07 + A1 + README + 本文）
    ├── superpowers/                 # 现 docs/superpowers/
    └── assets/marks/                # 现 gw-marks/
```

根级条目：**14 → 6**。

**一句话记忆**：`platform/` = 跑的架子（含其 GUI）｜`abilities/` = 插上去的能力｜`packages/` = 被依赖的库｜`docs/` = 看的。

### 两个命名决策的理由
- **脊柱独立成 `platform/`，不进笼统 `apps/`**：`service-gateway` 是常驻进程脊柱，不是"众多 app 之一"；`abilities/` 与它是"宿主 ↔ 插件"关系，分属两个顶层目录，对应 PRODUCT 的"脊柱 + 可插拔能力"模型。
- **GUI 放 `platform/console/`，不嵌进 `service-gateway/`**：它和 gateway 是同一个 console 连接器的两端（Node 端 `service-gateway/connectors/console/http.ts` ↔ Rust 端 GUI）。嵌进 Node 项目树会让 Rust 工具链污染 `npm`/`tsc` 扫描；脱离 gateway 又无独立意义，故与 gateway 平级、同属 `platform/`。

---

## 三、搬迁映射（逐项，全部 `git mv` 保留历史）

| 现路径 | 目标路径 | 备注 |
|---|---|---|
| `PRODUCT.md` `ARCHITECTURE.md` `CHANGES.md` | `docs/` | |
| `design/` | `docs/design/` | 含本文 |
| `docs/superpowers/` | `docs/superpowers/` | 并入新 docs 体系 |
| `gw-marks/` | `docs/assets/marks/` | 截图 |
| `service-gateway/` | `platform/service-gateway/` | 整体 |
| `gateway-console/` | `platform/console/` | 整体（Rust `target/` 仍 gitignored） |
| `atomic-abilities/` | `packages/atomic-abilities/` | 共享库 |
| `domains/` `skills/` `tests/` | `abilities/data-analysis/…` | |
| `knowledge-store/` `outputs/` | `abilities/data-analysis/…` | gitignored，留 `.gitkeep` |
| `app.config*.json` `app.config.md` `.env.local` | `abilities/data-analysis/…` | |
| `package.json` `package-lock.json` `tsconfig.tools.json` | `abilities/data-analysis/…` | 本体自己的清单 |
| `build/` | `abilities/data-analysis/build/` | gitignored，删后重编即可 |
| `README.md` | 保留根级 | 内容更新指向新路径 |
| `package.json`（新） | 根级新建 | workspace-only |

---

## 四、引用修复清单（搬完必须同步改）

**① 最关键的耦合点 —— service-gateway 运行分析能力的 cwd**
- `service-gateway/capabilities/data-analysis/runner.ts:228-232`：`skills/data-analytics/SKILL.md`、`node build/domains/.../cli.js` 是相对 cwd 的硬编码。
- 调用方传入的 `opts.cwd`（runner.ts:21,41,125）：从"仓库根"改为 `abilities/data-analysis/`。

**② 包与编译配置**
- 新根 `package.json`：`workspaces: ["platform/*", "abilities/*", "packages/*"]`。
- `abilities/data-analysis/package.json`：`file:./atomic-abilities` → `file:../../packages/atomic-abilities`。
- `tsconfig.tools.json`：`include`/`outDir`/`exclude` 路径（`service-gateway` 已不在同级，exclude 可删）。

**③ gitignore / 数据域脚本**
- `.gitignore`：`knowledge-store/`、`outputs/`、`build/`、`service-gateway/...` 加 `abilities/data-analysis/` 或 `platform/` 前缀。
- 各 `module.json` 的 `update.cmd` / `check.cmd`（含 `domains/...`、`knowledge-update/...` 前缀）。

**④ 文档自指**
- `ARCHITECTURE.md` 第三节"目标结构"图、`README.md` 的 Commands 段。

---

## 五、执行顺序（分批提交，降低出错）

1. **纯文档批**（零代码风险）：`docs/` 聚合 + `gw-marks`。先提交一次。
2. **平台批**：`service-gateway` → `platform/service-gateway/`、`gateway-console` → `platform/console/`；改 gateway 对外部根的引用（主要是 `cwd`）。
3. **能力本体批**：根级一组 → `abilities/data-analysis/`；改 `package.json`/`tsconfig`/`module.json`/`.gitignore`。
4. **共享库批**：`atomic-abilities` → `packages/`；改 `file:` 依赖。
5. **新根 workspace** + 删旧 `build/` → `npm install && npm run build:tools && npm test` 验证；再跑一次 service-gateway 触发一条分析任务，确认 cwd 链路通。

风险集中在第 2、3 步的 `cwd` 与相对路径；文档批可随时单独先做。

---

## 六、增强
- **已采用 npm workspaces**（2026-06-16）：根 `package.json` 声明 `workspaces: ["packages/*","abilities/*","platform/service-gateway"]`，根目录一次 `npm install` 装齐并软链全部子项目，单一 lock。`abilities/data-analysis` 对 `atomic-abilities` 的依赖由 `file:` 改为 `"*"`（workspace 解析）。
  - **配套修复**：提升（hoist）会把 `@zed-industries/claude-code-acp` 的 bin 移到根 `node_modules/.bin`，故 `service.ts` 的 ACP cmd 解析改为 sgRoot/repoRoot 两处候选取先命中者，兼容 workspace 与独立安装两种布局。
  - `platform/console` 是 Rust crate（无 package.json），故 workspaces 用 `platform/service-gateway` 精确匹配而非 `platform/*`。
- 仓库目录名 `data-analysis` 已与实际（WorkCortex）不符，可后续单独重命名（本方案不含）。
