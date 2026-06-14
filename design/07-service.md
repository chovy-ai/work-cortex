# 07 · service（进程编排：启动 / 退出 / 自愈）

状态：✅ 已定稿（2026-06-12）

## 职责与边界

daemon 入口：加载配置、自检前置条件、按依赖序组装并启动各模块、处理进程信号、统一日志出口。**自己不含任何业务逻辑**——它是把 02–06 拧在一起的螺丝刀。

不做：崩溃后的重启（交给 launchd `KeepAlive`，进程内不自我复活）。

## 依赖

- 02–06 全部模块
- launchd（macOS 本机部署，PRODUCT.md 已定）

## 接口与数据结构

### 配置（Q1）

`service-gateway/config.json`（gitignored，提供 `config.example.json`）：

```jsonc
{
  "runtime": { "maxConcurrent": 1, "timeoutSec": 600, "graceSec": 10 },
  "queue":   { "maxSize": 1000, "dedupCapacity": 4096 },
  "sessions": { "pendingPerConversation": 10 },
  "connectors": ["lark"],                  // 启用的连接器
  "capability": {                          // M0 单能力，常量直连
    "id": "data-analysis",
    "runtime": { "agent": "claude-code", "cmd": "npx claude-code-acp" }
  },
  "log": { "level": "info" }
}
```

环境变量可覆盖单项（`SG_RUNTIME_MAXCONCURRENT=2` 形式），便于临时调参不改文件。

### 启动序

```
1. 加载配置 + ajv 校验三个契约 schema 可解析
2. 前置自检（fail-fast，任一失败即退出并打印修复提示）：
   - lark-cli 存在且 `lark-cli doctor` 通过
   - ACP 适配器命令可执行、对应 agent CLI 已登录
   - knowledge-store/event-catalog.json 存在（M0 知识更新是手动前置）
   - outputs/ 可写
3. 组装：queue → sessions → runtime →（注入 sender）
4. 启动 lark listener（onEnvelope → queue.push）
5. 进入消费循环（for await queue.consume() → sessions）
```

### 退出序（SIGTERM / SIGINT，Q2）

```
1. listener.stop()        —— 不再收新事件
2. queue.stop()           —— 排空存量给 sessions（pending 的会话队列同样不再补新）
3. runtime：等待 running runs 自然完成，上限 30s
   超时 → abort 全部剩余 run（synthetic error，用户视角「没回」，重发即可）
4. 进程退出（exit 0）
```

二次 SIGINT（开发场景连按 Ctrl-C）：跳过等待直接 abort 退出。

### 日志（Q3）

- 结构化 JSON 行写 stdout，字段约定：`ts / level / module / run_id? / msg / detail?`；
- launchd 重定向 stdout/stderr 到 `~/Library/Logs/service-gateway/{out,err}.log`；
- 不引日志框架，`console.log(JSON.stringify(...))` 级别的薄封装即可（M0）；轮转交给后续 newsyslog 或 M3 迁服务器时一并解决。

### launchd（Q4）

`com.teamshell.service-gateway.plist`（仓库提供模板 + 安装说明）：

- `KeepAlive: true`（崩溃自愈——进程内不做的事它做）；
- `WorkingDirectory` = 仓库根；
- `EnvironmentVariables.PATH` 显式包含 nvm node 与 lark-cli 路径（launchd 不继承 shell 环境，这是最常见的坑）；
- `StandardOutPath` / `StandardErrorPath` 指向上述日志文件。

## 错误与重试

- 启动自检失败：exit 非零 + 明确修复提示；launchd 会重拉，但自检会再次拦住——人不修不会带病运行；
- 运行期未捕获异常：记日志后 exit 非零，交给 launchd 重拉（崩溃语义已接受：在途丢失）。

## 暂不做

| 项 | 回归时机 |
|---|---|
| 健康检查端点 / 指标暴露 | M2（监控） |
| 日志轮转 | M3 或迁服务器时 |
| 多连接器并启 | M3 |
| 配置热加载 | 需要时（M0 改配置 = 重启，launchd 秒级） |

## 开放问题

全部关闭（2026-06-12）：

- ~~**Q1 配置形态**~~ ✅ `config.json` + 环境变量单项覆盖。
- ~~**Q2 优雅退出**~~ ✅ 等 running run 完成上限 30s，超时 abort；二次 SIGINT 立即 abort。
- ~~**Q3 日志**~~ ✅ JSON 行 + launchd 重定向文件，M0 不引日志框架。
- ~~**Q4 launchd**~~ ✅ `KeepAlive` 自愈 + 显式 PATH，plist 模板进仓库。

## 验收标准

- 缺任一前置（lark-cli 未配置 / agent 未登录 / 无 event-catalog）启动即退出且提示准确；
- 正常启动后发飞书消息可收到回复（M0 端到端验收在此模块完成）；
- SIGTERM：在跑的 run 30s 内完成则正常回复后退出；构造超长 run 验证超时 abort 路径；
- `kill -9` 后 launchd 秒级重拉，进程恢复收消息；
- 日志文件中可按 run_id 串起一次 run 的完整轨迹。
