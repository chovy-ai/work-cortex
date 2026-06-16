# WorkCortex（智核）

团队的 AI 工作任务处理核心：用自然语言提需求，居中的智能中枢理解后调度各 agent 能力把活办成。数据分析（问数）是第一个能力，未来扩展到研发 / 办公等更多能力。

## 仓库结构

```
platform/            脊柱（常驻进程 + 其客户端）
├── service-gateway/   连接器 / 网关 / 能力宿主（Node 常驻进程）
└── console/           桌面监控 GUI（Rust）
abilities/           插进脊柱的能力
└── data-analysis/     分析能力本体（domains / skills / 知识存储 / 产物）
packages/            共享库
└── atomic-abilities/  原子能力（runStructured / imageGenerate …）
docs/                文档（PRODUCT / ARCHITECTURE / CHANGES / design / superpowers）
```

- 产品与交付架构：[docs/PRODUCT.md](docs/PRODUCT.md)（`platform/service-gateway` 是 WorkCortex 的常驻进程脊柱）
- 分析能力架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)（六领域 · 两条链路 · 知识存储接缝）
- 目录重整方案：[docs/design/migration-repo-layout.md](docs/design/migration-repo-layout.md)

## Commands

本仓库是 npm workspaces，根目录一次安装即装齐全部子项目并软链：

```bash
npm install            # 装 packages/* · abilities/* · platform/service-gateway，单一 lock
npm run build          # 依赖序构建：atomic → ability → gateway
npm test               # ability + gateway 测试
npm run start:gateway  # 启动常驻网关
```

单独构建/测试某一子项目：`npm run build:ability` / `test:gateway` 等（见 `package.json` scripts）。

分析能力内的工具按能力根的相对路径调用，例如：

```bash
cd abilities/data-analysis
node build/domains/datafinder-interface/cli.js list   # 凭据见 .env.local
```
