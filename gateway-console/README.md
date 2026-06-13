# Service Gateway 控制台

`service-gateway` 常驻进程的桌面监控 GUI，用 Rust + [egui/eframe](https://github.com/emilk/egui) 写成，视觉对齐 macOS（SF Pro / SF Mono 字体、系统色板、发丝分隔线、圆角卡片、原生标题栏与红绿灯）。

## 功能

四个视图（左侧导航切换）：

- **概览** —— 网关进程状态（运行中/已停止、PID、运行时长）、运行统计（完成/失败/进行中）、配置摘要、最近运行列表。
- **运行记录** —— 三栏式（导航｜列表｜详情）。列表读取 `outputs/run_*/`，详情展示输入文本、完整事件流（progress / result / error / ask），result 的表格按网格渲染。
- **日志** —— 优先读取 launchd 日志 `~/Library/Logs/service-gateway/out.log`（NDJSON 着色）；不存在时汇总各次运行的事件为活动流。
- **配置** —— 展示生效的 `service-gateway/config.json`（缺省回退到 `config.example.json` 并标注）。

**标记 / 审阅**（工具栏「标记」开关）—— 给我反馈样式用：
- 开启后悬停高亮任意区域并显示元素名（如「概览卡片 · 网关进程」「事件卡片 #3 · result」）；
- 点击选中该元素 → 底部出现评论框；写一句评论后点「复制截图」；
- 应用在元素上画珊瑚描边 + caption（元素名 / 尺寸 / 评论），用 `screencapture -c` 把这块带标注的截图**拷到剪贴板**，同时另存到 `gw-marks/`；
- 把截图粘到对话里，我即可凭「元素名 + 位置 + 评论」精准定位并改样式。

工具栏可**启动 / 停止 / 重启**网关：
- 停止 = 向 `pgrep -f dist/service.js` 命中的进程发 SIGTERM；
- 启动 = 在 `service-gateway/` 下 `nohup npm start`，输出追加到 launchd 日志路径；
- 状态每 2 秒自动刷新。

## 数据来源（只读）

| 数据 | 路径 |
| --- | --- |
| 运行轨迹 | `outputs/<run_id>/task.json` + `events.ndjson` |
| 配置 | `service-gateway/config.json`（回退 `config.example.json`） |
| 日志 | `~/Library/Logs/service-gateway/out.log` |
| 进程状态 | `pgrep -f dist/service.js` / `ps -o etime=` |

仓库根默认按本 crate 的上级目录推断，可用环境变量 `SG_REPO=/path/to/data-analysis` 覆盖。

## 构建运行

```sh
cargo run --release            # 直接运行
./bundle.sh                    # 生成可双击的 dist/Service Gateway Console.app
```

> 仓库位于 `~/Desktop` 下时，首次运行 macOS 会弹一次「访问桌面文件夹」授权框（读取 `outputs/`），点「允许」即可，属正常 TCC 行为。

## 截图取景用的环境变量（可选）

- `GW_VIEW=overview|runs|logs|config` —— 启动时的默认视图
- `GW_POS=x,y`、`GW_SIZE=w,h` —— 窗口初始位置与尺寸
- `GW_MARK=1` —— 启动即进入标记态；`GW_MARK_TEST=<元素名片段>` —— 自检：自动选中并抓屏
