# WorkCortex（智核）

团队的 AI 工作任务处理核心：用自然语言提需求，居中的智能中枢理解后调度各 agent 能力把活办成。数据分析（问数）是第一个能力，未来扩展到研发 / 办公等更多能力。

- 产品与交付架构：[PRODUCT.md](PRODUCT.md)（`service-gateway` 是 WorkCortex 的常驻进程脊柱）
- 分析能力架构：[ARCHITECTURE.md](ARCHITECTURE.md)（六领域 · 两条链路 · 知识存储接缝）

本仓库是 WorkCortex 的分析能力本体：应用分析知识、DataFinder OpenAPI 访问、查询执行协议的本地 TypeScript runtime。

## Commands

```bash
npm install
npm run typecheck
npm test
npm run datafinder -- list
npm run knowledge -- status
```
