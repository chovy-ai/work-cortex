# service-gateway

常驻进程：把本仓库的数据分析能力经飞书交付给团队。设计文档见 [`../design/`](../design/README.md)，架构总览见 [`../PRODUCT.md`](../PRODUCT.md)。

## 前置条件

1. Node ≥ 20；`npm install`
2. lark-cli 已配置 bot 凭据（`lark-cli doctor` 通过）
3. claude code 已登录（ACP 适配器 `claude-code-acp` 会拉起它）
4. 知识库已生成：`knowledge-store/event-catalog.json` 存在（见 ARCHITECTURE.md Phase 0）
5. `.env.local`（DataFinder 凭据）在仓库根

## 运行

```bash
npm run build        # tsc → dist/
npm test             # 单元测试（node:test）
npm start            # 前台运行（开发）
```

可选 `config.json`（参照 `config.example.json`，gitignored）；环境变量单项覆盖：
`SG_MAX_CONCURRENT` / `SG_TIMEOUT_S` / `SG_LOG_LEVEL` / `SG_SKIP_DOCTOR=1`。

## 常驻部署（launchd）

```bash
npm run build
mkdir -p ~/Library/Logs/service-gateway
# 编辑 launchd/com.teamshell.service-gateway.plist 中的三处本机路径
cp launchd/com.teamshell.service-gateway.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.teamshell.service-gateway.plist
tail -f ~/Library/Logs/service-gateway/out.log
```

停止：`launchctl unload ~/Library/LaunchAgents/com.teamshell.service-gateway.plist`

## 运行痕迹

每个 run 一个目录 `../outputs/<run_id>/`：`task.json`（输入快照）+ `events.ndjson`（完整事件流）+ agent 产物。
