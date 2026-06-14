//! 控制台界面：工具栏 + 导航栏 + 列表 + 详情，四个视图（概览/运行记录/日志/配置）。

use std::cell::RefCell;
use std::time::{Duration, Instant};

use eframe::egui::{
    self, Align2, Color32, FontId, Id, LayerId, Margin, Order, Pos2, Rect, RichText, Rounding,
    Sense, Stroke, Ui, vec2,
};
use egui_commonmark::{CommonMarkCache, CommonMarkViewer};

thread_local! {
    static MD_CACHE: RefCell<CommonMarkCache> = RefCell::new(CommonMarkCache::default());
    // 代码/文本产物的内容缓存，键含文件大小，文件增长后自动失效重读。
    static CODE_CACHE: RefCell<std::collections::HashMap<String, (String, bool)>> =
        RefCell::new(std::collections::HashMap::new());
}

use crate::control::{self, Status};
use crate::mark::{self, Capture, Mark};
use crate::model::{self, LogLine, Paths, Run, RunStatus};
use crate::theme::Palette;

#[derive(Clone, Copy, PartialEq, Eq)]
enum View {
    Chat,
    Overview,
    Runs,
    Logs,
    Config,
}

#[derive(Clone, Copy)]
enum NavIcon {
    Chat,
    Overview,
    Runs,
    Logs,
    Config,
}

pub struct ConsoleApp {
    paths: Paths,
    view: View,
    status: Status,
    runs: Vec<Run>,
    selected: Option<String>, // 选中的 run_id
    last_refresh: Instant,
    toast: Option<(String, Instant)>,
    config_cache: Option<(String, bool)>,

    // 查询输入（概览页发起 → console HTTP 连接器 → 队列）
    query_input: String,
    query_busy: bool,
    query_rx: Option<std::sync::mpsc::Receiver<crate::query::QueryOutcome>>,
    follow_latest: bool, // 提交后自动跟随最新 run，直到用户手动选中其它记录
    composer_focused: bool, // 上一帧输入框是否聚焦（用于「聚焦时 Enter 发送」在 add 前拦截回车）

    // 标记/审阅态
    mark_mode: bool,
    mark_tags: Vec<(String, Rect)>, // 本帧登记的可标记元素（mark_mode 时填充）
    hover_name: Option<String>,     // 上一帧命中的元素名
    marker: Option<Mark>,           // 已选中的标记目标
    capture: Capture,
    mark_seq: usize,
    mark_test: Option<String>,      // 截图自检：按名自动选中并抓屏（GW_MARK_TEST）
}

impl ConsoleApp {
    pub fn new() -> Self {
        let paths = Paths::discover();
        let status = control::probe();
        let runs = model::load_runs(&paths.outputs);
        let config_cache = model::load_config_text(&paths);
        let view = match std::env::var("GW_VIEW").as_deref() {
            Ok("overview") => View::Overview,
            Ok("runs") => View::Runs,
            Ok("logs") => View::Logs,
            Ok("config") => View::Config,
            // 默认落在「对话」视图：控制台的主入口是发起查询。
            _ => View::Chat,
        };
        // 进入运行记录 / 对话视图时默认选中最近一条有事件的记录，
        // 运行记录用于展示详情；对话则把它渲染成会话流（不开启跟随，避免打断浏览）。
        let selected = if matches!(view, View::Runs | View::Chat) {
            let want = std::env::var("GW_SEL").ok();
            want.and_then(|w| runs.iter().find(|r| r.run_id.contains(&w)))
                .or_else(|| runs.iter().find(|r| !r.text.is_empty() && !r.events.is_empty()))
                .or_else(|| runs.iter().find(|r| !r.events.is_empty()))
                .or_else(|| runs.first())
                .map(|r| r.run_id.clone())
        } else {
            None
        };
        Self {
            paths,
            view,
            status,
            runs,
            selected,
            last_refresh: Instant::now(),
            toast: None,
            config_cache,
            query_input: String::new(),
            query_busy: false,
            query_rx: None,
            follow_latest: false,
            composer_focused: false,
            mark_tags: Vec::new(),
            hover_name: None,
            marker: None,
            capture: Capture::Idle,
            mark_seq: 0,
            mark_mode: std::env::var("GW_MARK").is_ok() || std::env::var("GW_MARK_TEST").is_ok(),
            mark_test: std::env::var("GW_MARK_TEST").ok(),
        }
    }

    /// 在 mark_mode 下登记一个可标记元素的语义名 + 屏幕矩形。
    fn tag(&mut self, name: &str, rect: Rect) {
        if self.mark_mode {
            self.mark_tags.push((name.to_owned(), rect));
        }
    }

    fn refresh(&mut self) {
        self.status = control::probe();
        self.runs = model::load_runs(&self.paths.outputs);
        self.config_cache = model::load_config_text(&self.paths);
        // 跟随模式：选中最新一条（提交查询后新 run 出现即自动展示）。
        if self.follow_latest {
            if let Some(first) = self.runs.first() {
                self.selected = Some(first.run_id.clone());
            }
        }
        self.last_refresh = Instant::now();
    }

    fn notify(&mut self, msg: impl Into<String>) {
        self.toast = Some((msg.into(), Instant::now()));
    }

    /// 从配置（config.json 或示例）解析 console 连接器端点，缺省回环 8765。
    fn console_endpoint(&self) -> (String, u16) {
        let Some((text, _)) = &self.config_cache else {
            return ("127.0.0.1".into(), 8765);
        };
        let v: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::Value::Null);
        let host = v
            .pointer("/console/host")
            .and_then(|x| x.as_str())
            .unwrap_or("127.0.0.1")
            .to_owned();
        let port = v
            .pointer("/console/port")
            .and_then(|x| x.as_u64())
            .unwrap_or(8765) as u16;
        (host, port)
    }

    /// 发起一次查询：后台线程 POST /query，结果经 channel 回 UI 线程。
    fn start_query(&mut self, ctx: &egui::Context) {
        let text = self.query_input.trim().to_owned();
        if text.is_empty() {
            self.notify("请输入查询内容");
            return;
        }
        if self.query_busy {
            return;
        }
        let (host, port) = self.console_endpoint();
        let (tx, rx) = std::sync::mpsc::channel();
        self.query_rx = Some(rx);
        self.query_busy = true;
        let ctx = ctx.clone();
        std::thread::spawn(move || {
            let out = crate::query::submit_query(&host, port, &text);
            let _ = tx.send(out);
            ctx.request_repaint(); // 唤醒 UI 线程回收结果
        });
        self.notify("正在提交查询…");
    }

    /// 回收后台查询提交的结果（每帧轮询）。
    fn poll_query(&mut self) {
        let outcome = self.query_rx.as_ref().and_then(|rx| rx.try_recv().ok());
        let Some(out) = outcome else { return };
        self.query_busy = false;
        self.query_rx = None;
        match out {
            crate::query::QueryOutcome::Ok => {
                self.query_input.clear();
                self.view = View::Chat;
                self.follow_latest = true;
                self.notify("已提交，正在执行…");
                self.refresh();
            }
            crate::query::QueryOutcome::Err(e) => self.notify(format!("提交失败：{e}")),
        }
    }

    fn selected_run(&self) -> Option<&Run> {
        let id = self.selected.as_ref()?;
        self.runs.iter().find(|r| &r.run_id == id)
    }
}

impl eframe::App for ConsoleApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // 回收后台查询提交结果（若有）。
        self.poll_query();
        // 每 2 秒自动刷新一次状态与运行记录。
        if self.last_refresh.elapsed() > Duration::from_secs(2) {
            self.refresh();
        }
        ctx.request_repaint_after(Duration::from_secs(2));

        // 标记态每帧重建元素登记表。
        if self.mark_mode {
            self.mark_tags.clear();
        }

        let toolbar_frame = egui::Frame::none()
            .fill(Palette::TOOLBAR_BG)
            .inner_margin(Margin::symmetric(16.0, 9.0));
        egui::TopBottomPanel::top("toolbar")
            .frame(toolbar_frame)
            .show(ctx, |ui| self.toolbar(ui));

        let nav_frame = egui::Frame::none()
            .fill(Palette::SIDEBAR_BG)
            .inner_margin(Margin::symmetric(10.0, 14.0));
        egui::SidePanel::left("nav")
            .exact_width(212.0)
            .resizable(false)
            .frame(nav_frame)
            .show(ctx, |ui| self.nav(ui));

        if self.view == View::Runs {
            let list_frame = egui::Frame::none()
                .fill(Color32::from_rgb(247, 245, 238))
                .inner_margin(Margin::symmetric(0.0, 8.0));
            egui::SidePanel::left("runlist")
                .default_width(312.0)
                .width_range(250.0..=440.0)
                .frame(list_frame)
                .show(ctx, |ui| self.run_list(ui));
        }

        if self.mark_mode {
            self.mark_bar(ctx);
        }

        // 对话视图：底部常驻输入框（消息流在中央面板里滚动）。
        if self.view == View::Chat {
            self.chat_composer(ctx);
        }

        let central_frame = egui::Frame::none()
            .fill(Palette::WINDOW_BG)
            .inner_margin(Margin::same(20.0));
        egui::CentralPanel::default()
            .frame(central_frame)
            .show(ctx, |ui| match self.view {
                View::Chat => self.view_chat(ui),
                View::Overview => self.view_overview(ui),
                View::Runs => self.view_run_detail(ui),
                View::Logs => self.view_logs(ui),
                View::Config => self.view_config(ui),
            });

        if self.mark_mode {
            self.mark_overlay(ctx);
        }
    }
}

// ───────────────────────────── 工具栏 ─────────────────────────────

impl ConsoleApp {
    fn toolbar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.add_space(2.0);
            ui.label(RichText::new("Service Gateway").size(15.0).strong());
            ui.add_space(10.0);
            status_pill(ui, &self.status);

            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                if ghost_button(ui, "刷新") {
                    self.refresh();
                    self.notify("已刷新");
                }
                ui.add_space(6.0);
                let running = self.status.running;
                if !self.mark_mode && running {
                    if action_button(ui, "重启", Palette::ORANGE, Color32::WHITE) {
                        if let Some(pid) = self.status.pid {
                            let _ = control::stop(pid);
                        }
                        let _ = control::start(&self.paths.sg_dir, &self.paths.launchd_log);
                        self.notify("已发送重启（停止 + 启动）");
                    }
                    ui.add_space(6.0);
                    if action_button(ui, "停止", Palette::RED, Color32::WHITE) {
                        match self.status.pid.map(control::stop) {
                            Some(Ok(())) => self.notify("已发送停止信号"),
                            Some(Err(e)) => self.notify(format!("停止失败：{e}")),
                            None => self.notify("未发现进程"),
                        }
                    }
                } else if !self.mark_mode && !running && action_button(ui, "启动", Palette::GREEN, Color32::WHITE) {
                    match control::start(&self.paths.sg_dir, &self.paths.launchd_log) {
                        Ok(()) => self.notify("已发送启动命令（npm start，构建需数秒）"),
                        Err(e) => self.notify(format!("启动失败：{e}")),
                    }
                }
                ui.add_space(6.0);
                // 标记/审阅开关
                let toggled = if self.mark_mode {
                    action_button(ui, "标记中 ✓", Palette::ACCENT, Color32::WHITE)
                } else {
                    ghost_button(ui, "标记")
                };
                if toggled {
                    self.mark_mode = !self.mark_mode;
                    if !self.mark_mode {
                        self.marker = None;
                        self.hover_name = None;
                        self.capture = Capture::Idle;
                    }
                }

                // toast：4 秒内显示在右侧动作按钮左边。
                if let Some((msg, at)) = &self.toast {
                    if at.elapsed() < Duration::from_secs(4) {
                        ui.add_space(12.0);
                        ui.label(
                            RichText::new(msg)
                                .size(12.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                    }
                }
            });
        });
    }
}

// ───────────────────────────── 标记 / 审阅 ─────────────────────────────

impl ConsoleApp {
    /// 底部标记栏：显示悬停/选中的元素、评论输入、复制截图。
    fn mark_bar(&mut self, ctx: &egui::Context) {
        let mut do_copy = false;
        let mut do_clear = false;
        let frame = egui::Frame::none()
            .fill(Palette::CARD_BG_ALT)
            .inner_margin(Margin::symmetric(16.0, 9.0));
        egui::TopBottomPanel::bottom("mark-bar")
            .frame(frame)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("● 标记模式")
                            .size(12.5)
                            .strong()
                            .color(Palette::ACCENT),
                    );
                    ui.add_space(10.0);
                    if let Some(m) = &mut self.marker {
                        ui.label(RichText::new(&m.name).size(12.5).strong());
                        ui.add_space(8.0);
                        ui.add(
                            egui::TextEdit::singleline(&mut m.comment)
                                .hint_text("写一句评论…")
                                .desired_width(300.0),
                        );
                        ui.with_layout(
                            egui::Layout::right_to_left(egui::Align::Center),
                            |ui| {
                                if ghost_button(ui, "清除") {
                                    do_clear = true;
                                }
                                ui.add_space(6.0);
                                if action_button(ui, "复制截图", Palette::ACCENT, Color32::WHITE) {
                                    do_copy = true;
                                }
                            },
                        );
                    } else {
                        let hint = self
                            .hover_name
                            .clone()
                            .map(|n| format!("悬停：{n}　—　点击选中要标注的元素"))
                            .unwrap_or_else(|| "把鼠标移到任意区域，点击选中要标注的元素".into());
                        ui.label(RichText::new(hint).size(12.5).color(Palette::TEXT_SECONDARY));
                    }
                });
            });
        if do_clear {
            self.marker = None;
        }
        if do_copy && self.marker.is_some() {
            self.capture = Capture::Armed(2);
        }
    }

    /// 前景层：命中检测、悬停/选中高亮、截图时序。
    fn mark_overlay(&mut self, ctx: &egui::Context) {
        ctx.request_repaint(); // 持续重绘以跟手
        let painter = ctx.layer_painter(LayerId::new(Order::Foreground, Id::new("mark-overlay")));
        let pointer = ctx.input(|i| i.pointer.interact_pos());
        let clicked = ctx.input(|i| i.pointer.primary_clicked());

        // 命中：包含指针、面积最小的元素（最具体）。
        let hovered: Option<(String, Rect)> = pointer.and_then(|p| {
            self.mark_tags
                .iter()
                .filter(|(_, r)| r.contains(p))
                .min_by(|a, b| {
                    (a.1.area())
                        .partial_cmp(&b.1.area())
                        .unwrap_or(std::cmp::Ordering::Equal)
                })
                .cloned()
        });
        self.hover_name = hovered.as_ref().map(|(n, _)| n.clone());

        // 自检：按名自动选中并抓屏（GW_MARK_TEST）。
        if let Some(want) = self.mark_test.clone() {
            if self.marker.is_none() {
                if let Some((name, rect)) = self
                    .mark_tags
                    .iter()
                    .find(|(n, _)| n.contains(&want))
                    .cloned()
                {
                    self.marker = Some(Mark {
                        name,
                        rect,
                        comment: "自检标注".into(),
                    });
                    self.capture = Capture::Armed(2);
                    self.mark_test = None;
                }
            }
        }

        // 悬停高亮（未选中时）
        if self.marker.is_none() {
            if let Some((_, r)) = &hovered {
                painter.rect_filled(*r, Rounding::same(8.0), Palette::ACCENT.gamma_multiply(0.06));
                painter.rect_stroke(
                    *r,
                    Rounding::same(8.0),
                    Stroke::new(1.5, Palette::ACCENT.gamma_multiply(0.8)),
                );
            }
        }

        // 点击选中
        if clicked && self.capture == Capture::Idle {
            if let Some((name, r)) = hovered {
                self.marker = Some(Mark {
                    name,
                    rect: r,
                    comment: String::new(),
                });
            }
        }

        // 选中高亮 + 截图时序
        if let Some(m) = self.marker.clone() {
            painter.rect_stroke(m.rect, Rounding::same(8.0), Stroke::new(2.5, Palette::ACCENT));
            if let Capture::Armed(n) = self.capture {
                draw_annotation(&painter, &m);
                if n == 0 {
                    self.do_capture(ctx, &m);
                    self.capture = Capture::Idle;
                } else {
                    self.capture = Capture::Armed(n - 1);
                }
            }
        } else {
            self.capture = Capture::Idle;
        }
    }

    /// 把元素当前所在的屏幕矩形（含标注）抓屏到剪贴板。
    fn do_capture(&mut self, ctx: &egui::Context, m: &Mark) {
        let Some(inner) = ctx.input(|i| i.viewport().inner_rect) else {
            self.notify("无法获取窗口位置，截图失败");
            return;
        };
        // 元素矩形上扩 30（容纳 caption）、四周留白 10。
        let mut region = m.rect;
        region.min.y -= 30.0;
        let region = region.expand(10.0);
        let x = inner.min.x + region.min.x;
        let y = inner.min.y + region.min.y;
        self.mark_seq += 1;
        let dir = self.paths.repo_root.join("gw-marks");
        // 等 overlay 上屏后再抓
        std::thread::sleep(Duration::from_millis(60));
        match mark::capture_region(x, y, region.width(), region.height(), &dir, self.mark_seq) {
            Ok(path) => self.notify(format!(
                "已复制标记截图到剪贴板（另存 {}）",
                path.file_name().and_then(|s| s.to_str()).unwrap_or("mark.png")
            )),
            Err(e) => self.notify(format!("截图失败：{e}")),
        }
    }
}

// ───────────────────────────── 导航栏 ─────────────────────────────

impl ConsoleApp {
    fn nav(&mut self, ui: &mut Ui) {
        ui.add_space(2.0);
        ui.label(
            RichText::new("控制台")
                .size(11.0)
                .color(Palette::TEXT_SECONDARY)
                .strong(),
        );
        ui.add_space(6.0);

        let run_count = self.runs.len();
        let items = [
            (View::Chat, NavIcon::Chat, "对话", None),
            (View::Overview, NavIcon::Overview, "概览", None),
            (View::Runs, NavIcon::Runs, "运行记录", Some(run_count)),
            (View::Logs, NavIcon::Logs, "日志", None),
            (View::Config, NavIcon::Config, "配置", None),
        ];
        for (v, icon, label, badge) in items {
            let sel = self.view == v;
            let r = ui.scope(|ui| nav_row(ui, sel, icon, label, badge));
            if r.inner && !self.mark_mode {
                self.view = v;
            }
            self.tag(&format!("导航 · {label}"), r.response.rect);
        }

        // 底部：仓库路径与连接器信息。
        ui.with_layout(egui::Layout::bottom_up(egui::Align::Min), |ui| {
            ui.add_space(4.0);
            ui.label(
                RichText::new(self.paths.repo_root.to_string_lossy())
                    .size(10.0)
                    .color(Palette::TEXT_SECONDARY),
            );
            ui.label(
                RichText::new("仓库")
                    .size(10.0)
                    .color(Palette::TEXT_SECONDARY)
                    .strong(),
            );
            ui.add_space(8.0);
            ui.label(
                RichText::new("lark · data-analysis")
                    .size(10.0)
                    .color(Palette::TEXT_SECONDARY),
            );
            ui.label(
                RichText::new("连接器 · 能力")
                    .size(10.0)
                    .color(Palette::TEXT_SECONDARY)
                    .strong(),
            );
        });
    }
}

// ───────────────────────────── 运行记录列表 ─────────────────────────────

impl ConsoleApp {
    fn run_list(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            ui.add_space(14.0);
            ui.label(RichText::new("运行记录").size(13.0).strong());
            ui.label(
                RichText::new(format!("{}", self.runs.len()))
                    .size(12.0)
                    .color(Palette::TEXT_SECONDARY),
            );
        });
        ui.add_space(6.0);

        let mut clicked: Option<String> = None;
        let mut row_tags: Vec<(String, Rect)> = Vec::new();
        let mark_mode = self.mark_mode;
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                if self.runs.is_empty() {
                    ui.add_space(20.0);
                    ui.vertical_centered(|ui| {
                        ui.label(
                            RichText::new("暂无运行记录")
                                .color(Palette::TEXT_SECONDARY),
                        );
                    });
                }
                for run in &self.runs {
                    let selected = self.selected.as_deref() == Some(run.run_id.as_str());
                    let r = ui.scope(|ui| run_list_row(ui, run, selected));
                    if r.inner && !mark_mode {
                        clicked = Some(run.run_id.clone());
                    }
                    if mark_mode {
                        row_tags.push((
                            format!("运行记录行 · {}", short_id(&run.run_id)),
                            r.response.rect,
                        ));
                    }
                }
            });
        for (name, rect) in row_tags {
            self.tag(&name, rect);
        }
        if let Some(id) = clicked {
            self.selected = Some(id);
            self.follow_latest = false; // 手动选中即停止跟随
        }
    }
}

// ───────────────────────────── 概览视图 ─────────────────────────────

impl ConsoleApp {
    fn view_overview(&mut self, ui: &mut Ui) {
        ui.label(RichText::new("概览").size(22.0).strong());
        ui.add_space(2.0);
        ui.label(
            RichText::new("常驻网关进程与查询链路的实时状态")
                .size(13.0)
                .color(Palette::TEXT_SECONDARY),
        );
        ui.add_space(16.0);

        let total = self.runs.len();
        let done = self.runs.iter().filter(|r| r.status == RunStatus::Done).count();
        let failed = self.runs.iter().filter(|r| r.status == RunStatus::Failed).count();
        let running = self
            .runs
            .iter()
            .filter(|r| r.status == RunStatus::Running)
            .count();

        // 卡片整体 + 卡片内的叶子元素都登记，悬停时命中面积最小者（最具体），
        // 这样标记框能贴住「状态/统计数字/配置项」本身，而不是跳到整张卡片。
        let mut card_tags: Vec<(String, Rect)> = Vec::new();
        let mut leaf_tags: Vec<(String, Rect)> = Vec::new();
        ui.columns(3, |cols| {
            // 卡片 1：进程状态
            let r0 = cols[0].scope(|ui| {
                card(ui, |ui| {
                    ui.set_min_height(120.0);
                    ui.label(
                        RichText::new("网关进程")
                            .size(12.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                    ui.add_space(8.0);
                    let st = ui.scope(|ui| {
                        ui.horizontal(|ui| {
                            let (dot, text) = if self.status.running {
                                (Palette::GREEN, "运行中")
                            } else {
                                (Palette::GRAY, "已停止")
                            };
                            let (r, _) = ui.allocate_exact_size(vec2(12.0, 12.0), Sense::hover());
                            ui.painter().circle_filled(r.center(), 5.0, dot);
                            ui.label(RichText::new(text).size(22.0).strong());
                        });
                    });
                    leaf_tags.push(("概览 · 网关状态".into(), st.response.rect));
                    ui.add_space(4.0);
                    if let Some(pid) = self.status.pid {
                        ui.label(
                            RichText::new(format!("PID {pid}"))
                                .size(12.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                    }
                    if let Some(up) = &self.status.uptime {
                        ui.label(
                            RichText::new(format!("已运行 {up}"))
                                .size(12.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                    }
                });
            });
            card_tags.push(("概览卡片 · 网关进程".into(), r0.response.rect));

            // 卡片 2：运行统计
            let r1 = cols[1].scope(|ui| {
                card(ui, |ui| {
                    ui.set_min_height(120.0);
                    ui.label(
                        RichText::new("运行记录")
                            .size(12.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                    ui.add_space(8.0);
                    ui.label(RichText::new(format!("{total}")).size(22.0).strong());
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        let c0 = ui.scope(|ui| stat_chip(ui, "完成", done, Palette::GREEN));
                        let c1 = ui.scope(|ui| stat_chip(ui, "失败", failed, Palette::RED));
                        let c2 = ui.scope(|ui| stat_chip(ui, "进行", running, Palette::ORANGE));
                        leaf_tags.push(("概览 · 完成数".into(), c0.response.rect));
                        leaf_tags.push(("概览 · 失败数".into(), c1.response.rect));
                        leaf_tags.push(("概览 · 进行数".into(), c2.response.rect));
                    });
                });
            });
            card_tags.push(("概览卡片 · 运行统计".into(), r1.response.rect));

            // 卡片 3：配置摘要
            let r2 = cols[2].scope(|ui| {
                card(ui, |ui| {
                    ui.set_min_height(120.0);
                    ui.label(
                        RichText::new("运行配置")
                            .size(12.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                    ui.add_space(8.0);
                    let cfg = self.config_cache.as_ref().map(|(s, _)| parse_cfg(s));
                    let (mc, to, agent) = cfg.unwrap_or(("?".into(), "?".into(), "?".into()));
                    let k0 = ui.scope(|ui| kv_line(ui, "并发上限", &mc));
                    let k1 = ui.scope(|ui| kv_line(ui, "超时(秒)", &to));
                    let k2 = ui.scope(|ui| kv_line(ui, "Agent", &agent));
                    leaf_tags.push(("概览 · 并发上限".into(), k0.response.rect));
                    leaf_tags.push(("概览 · 超时".into(), k1.response.rect));
                    leaf_tags.push(("概览 · Agent".into(), k2.response.rect));
                });
            });
            card_tags.push(("概览卡片 · 运行配置".into(), r2.response.rect));
        });
        for (name, rect) in card_tags {
            self.tag(&name, rect);
        }
        for (name, rect) in leaf_tags {
            self.tag(&name, rect);
        }

        ui.add_space(16.0);

        // 最近运行
        let mark_mode = self.mark_mode;
        let mut recent_tags: Vec<(String, Rect)> = Vec::new();
        let rr = ui.scope(|ui| {
            card(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("最近运行").size(14.0).strong());
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui
                            .add(egui::Label::new(
                                RichText::new("查看全部 ›").size(12.0).color(Palette::ACCENT),
                            ).sense(Sense::click()))
                            .clicked()
                            && !mark_mode
                        {
                            self.view = View::Runs;
                        }
                    });
                });
                ui.add_space(8.0);
                if self.runs.is_empty() {
                    ui.label(
                        RichText::new("暂无运行记录")
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
                let mut goto: Option<String> = None;
                let recent: Vec<&Run> = self.runs.iter().take(6).collect();
                let last = recent.len().saturating_sub(1);
                for (i, run) in recent.iter().enumerate() {
                    let rw = ui.scope(|ui| recent_run_row(ui, run, i == last));
                    if rw.inner && !mark_mode {
                        goto = Some(run.run_id.clone());
                    }
                    recent_tags.push((
                        format!("最近运行 · {}", short_id(&run.run_id)),
                        rw.response.rect,
                    ));
                }
                if let Some(id) = goto {
                    self.selected = Some(id);
                    self.follow_latest = false; // 手动选中即停止跟随
                    self.view = View::Runs;
                }
            });
        });
        self.tag("概览 · 最近运行", rr.response.rect);
        for (name, rect) in recent_tags {
            self.tag(&name, rect);
        }
    }
}

// ───────────────────────────── 对话视图 ─────────────────────────────

impl ConsoleApp {
    /// 对话视图：上方会话流（用户提问气泡 + 助手事件气泡），输入框由 chat_composer 常驻底部。
    fn view_chat(&mut self, ui: &mut Ui) {
        let Some(run) = self.selected_run().cloned() else {
            self.chat_empty_hero(ui);
            return;
        };
        let mark_mode = self.mark_mode;

        // 顶部细条：当前会话状态 + 提问摘要 + 新对话。
        let mut new_chat = false;
        let header = ui.scope(|ui| {
            ui.horizontal(|ui| {
                status_badge(ui, run.status);
                ui.add_space(8.0);
                let title = if run.text.is_empty() {
                    "(无输入文本)".to_owned()
                } else {
                    truncate(&run.text, 38)
                };
                ui.label(RichText::new(title).size(15.0).strong());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ghost_button(ui, "新对话") && !mark_mode {
                        new_chat = true;
                    }
                });
            });
        });
        self.tag("对话 · 标题条", header.response.rect);
        ui.add_space(6.0);

        let mut bubble_tags: Vec<(String, Rect)> = Vec::new();
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .stick_to_bottom(true)
            .show(ui, |ui| {
                // 用户提问气泡（右对齐）
                let r = chat_user_bubble(ui, &run.text);
                bubble_tags.push(("对话 · 用户提问".into(), r));
                ui.add_space(12.0);

                // 助手事件逐条成泡（左对齐）
                for ev in &run.events {
                    let r = chat_event(ui, ev);
                    bubble_tags.push((format!("对话气泡 #{} · {}", ev.seq, ev.kind), r));
                    ui.add_space(10.0);
                }

                if run.status == RunStatus::Running {
                    chat_typing(ui);
                } else if run.events.is_empty() {
                    ui.add_space(4.0);
                    ui.label(
                        RichText::new("已受理，等待网关开始执行…")
                            .size(12.5)
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
            });

        for (name, rect) in bubble_tags {
            self.tag(&name, rect);
        }
        if new_chat {
            self.selected = None;
            self.follow_latest = false;
        }
    }

    /// 对话空状态：居中欢迎语 + 示例提示（点击填入），输入框仍在底部常驻。
    fn chat_empty_hero(&mut self, ui: &mut Ui) {
        ui.add_space(72.0);
        let mark_mode = self.mark_mode;
        let running = self.status.running;
        let mut fill: Option<String> = None;
        let mut chip_tags: Vec<(String, Rect)> = Vec::new();
        ui.vertical_centered(|ui| {
            ui.label(RichText::new("发起查询").size(26.0).strong());
            ui.add_space(8.0);
            ui.label(
                RichText::new("用自然语言提问数据问题，结果会以对话的形式逐步返回")
                    .size(14.0)
                    .color(Palette::TEXT_SECONDARY),
            );
            if !running {
                ui.add_space(10.0);
                ui.label(
                    RichText::new("网关当前未运行 · 在「概览」启动后再提交")
                        .size(12.5)
                        .color(Palette::ORANGE),
                );
            }
            ui.add_space(20.0);
            for ex in [
                "昨天各渠道的新增用户数",
                "上周 DAU 的日趋势",
                "本月 GMV 同比去年",
            ] {
                let r = ui.scope(|ui| example_chip(ui, ex));
                if r.inner && !mark_mode {
                    fill = Some(ex.to_owned());
                }
                chip_tags.push((format!("对话 · 示例「{ex}」"), r.response.rect));
                ui.add_space(8.0);
            }
        });
        for (name, rect) in chip_tags {
            self.tag(&name, rect);
        }
        if let Some(text) = fill {
            self.query_input = text;
        }
    }

    /// 底部常驻输入框：多行输入 + 发送（⌘/Ctrl+Enter 亦可）。
    fn chat_composer(&mut self, ctx: &egui::Context) {
        let busy = self.query_busy;
        let mark_mode = self.mark_mode;
        let running = self.status.running;
        let focused = self.composer_focused; // 上一帧聚焦态（本帧在 add 前拦截回车要用）
        let mut next_focused = false;
        let mut do_send = false;
        let mut composer_rect: Option<Rect> = None;

        let frame = egui::Frame::none()
            .fill(Palette::WINDOW_BG)
            .inner_margin(Margin::symmetric(20.0, 12.0));
        egui::TopBottomPanel::bottom("composer")
            .frame(frame)
            .show(ctx, |ui| {
                if !running {
                    ui.label(
                        RichText::new("网关未运行 · 提交会失败")
                            .size(11.0)
                            .color(Palette::ORANGE),
                    );
                    ui.add_space(4.0);
                }
                let card = egui::Frame::none()
                    .fill(Palette::CARD_BG)
                    .stroke(Stroke::new(1.0, Palette::HAIRLINE))
                    .rounding(Rounding::same(12.0))
                    .inner_margin(Margin::symmetric(12.0, 10.0))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            ui.with_layout(
                                egui::Layout::right_to_left(egui::Align::Center),
                                |ui| {
                                    let label = if busy { "提交中…" } else { "发送" };
                                    let (btn_fill, enabled) = if busy || mark_mode {
                                        (Palette::GRAY, false)
                                    } else {
                                        (Palette::ACCENT, true)
                                    };
                                    if action_button(ui, label, btn_fill, Color32::WHITE) && enabled
                                    {
                                        do_send = true;
                                    }
                                    ui.add_space(10.0);
                                    // 聚焦时拦截回车：Enter（含 ⌘/Ctrl+Enter）发送、Shift+Enter 换行。
                                    // 必须在 add(TextEdit) 之前 consume，否则多行框会先把回车插成换行。
                                    if focused {
                                        let send = ui.input_mut(|i| {
                                            i.consume_key(egui::Modifiers::NONE, egui::Key::Enter)
                                                || i.consume_key(
                                                    egui::Modifiers::COMMAND,
                                                    egui::Key::Enter,
                                                )
                                                || i.consume_key(
                                                    egui::Modifiers::CTRL,
                                                    egui::Key::Enter,
                                                )
                                        });
                                        if send {
                                            do_send = true;
                                        }
                                    }
                                    // 余下宽度交给输入框（单行起步，随内容增高）。
                                    let te = ui.add(
                                        egui::TextEdit::multiline(&mut self.query_input)
                                            .desired_rows(1)
                                            .desired_width(f32::INFINITY)
                                            .frame(false)
                                            .hint_text("输入要查询的数据问题，Enter 发送 · Shift+Enter 换行…")
                                            .font(FontId::proportional(14.0)),
                                    );
                                    next_focused = te.has_focus();
                                },
                            );
                        });
                    });
                composer_rect = Some(card.response.rect);
            });
        self.composer_focused = next_focused;
        if let Some(r) = composer_rect {
            self.tag("对话 · 输入框", r);
        }
        if do_send {
            self.start_query(ctx);
        }
    }
}

// ───────────────────────────── 对话气泡控件 ─────────────────────────────

/// 用户提问气泡：右对齐、珊瑚淡染、收缩包裹文本。返回气泡矩形（供标记）。
fn chat_user_bubble(ui: &mut Ui, text: &str) -> Rect {
    let max_w = (ui.available_width() * 0.78).max(160.0);
    let body = if text.is_empty() {
        "(无输入文本)".to_owned()
    } else {
        text.to_owned()
    };
    ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
        egui::Frame::none()
            .fill(Palette::ACCENT.gamma_multiply(0.16))
            .rounding(Rounding::same(13.0))
            .inner_margin(Margin::symmetric(14.0, 10.0))
            .show(ui, |ui| {
                ui.set_max_width(max_w);
                ui.label(RichText::new(body).size(14.5).color(Palette::TEXT));
            })
            .response
            .rect
    })
    .inner
}

/// 助手气泡：左对齐、白底、收缩包裹。`accent` 给特定语义（错误/提问）换描边色。
fn assistant_bubble(ui: &mut Ui, accent: Option<Color32>, add: impl FnOnce(&mut Ui)) -> Rect {
    let max_w = (ui.available_width() * 0.82).max(220.0);
    ui.horizontal(|ui| {
        egui::Frame::none()
            .fill(Palette::CARD_BG)
            .stroke(Stroke::new(1.0, accent.unwrap_or(Palette::HAIRLINE)))
            .rounding(Rounding::same(13.0))
            .inner_margin(Margin::symmetric(14.0, 11.0))
            .show(ui, |ui| {
                ui.set_max_width(max_w);
                add(ui);
            })
            .response
            .rect
    })
    .inner
}

/// 把一个事件渲染成对话气泡（按 kind 区分样式）。返回其矩形。
fn chat_event(ui: &mut Ui, ev: &model::Event) -> Rect {
    match ev.kind.as_str() {
        "progress" => {
            // 进度：左侧珊瑚小点 + 叙述（status 优先，回退原始工具 detail）。
            let text = ev
                .status
                .as_deref()
                .or(ev.detail.as_deref())
                .unwrap_or("执行中…");
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(vec2(10.0, 10.0), Sense::hover());
                ui.painter()
                    .circle_filled(r.center(), 3.0, Palette::ACCENT.gamma_multiply(0.7));
                ui.add(
                    egui::Label::new(
                        RichText::new(text).size(12.5).color(Palette::TEXT_SECONDARY),
                    )
                    .wrap(),
                );
            })
            .response
            .rect
        }
        "result" => assistant_bubble(ui, None, |ui| {
            if let Some(s) = &ev.summary {
                // summary 是 LLM 输出的 Markdown，按 Markdown 渲染。
                ui.push_id(ev.seq, |ui| {
                    MD_CACHE.with(|c| {
                        CommonMarkViewer::new().show(ui, &mut c.borrow_mut(), s);
                    });
                });
            }
            if let Some(tables) = &ev.tables {
                for t in tables {
                    ui.add_space(8.0);
                    render_table(ui, t);
                }
            }
        }),
        "error" => assistant_bubble(ui, Some(Palette::RED.gamma_multiply(0.55)), |ui| {
            if let Some(r) = &ev.reason {
                ui.colored_label(Palette::RED, RichText::new(r).size(13.5));
            }
            if ev.retriable == Some(true) {
                ui.label(
                    RichText::new("可重试")
                        .size(11.0)
                        .color(Palette::ORANGE),
                );
            }
        }),
        "ask" => assistant_bubble(ui, Some(Palette::ORANGE.gamma_multiply(0.6)), |ui| {
            if let Some(p) = &ev.prompt {
                ui.label(RichText::new(p).size(13.5));
            }
        }),
        other => ui
            .horizontal(|ui| {
                ui.label(
                    RichText::new(format!("· {other}"))
                        .size(12.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            })
            .response
            .rect,
    }
}

/// 「正在执行」指示（run 仍在进行时显示在会话流底部）。
fn chat_typing(ui: &mut Ui) {
    ui.horizontal(|ui| {
        let (r, _) = ui.allocate_exact_size(vec2(10.0, 10.0), Sense::hover());
        ui.painter().circle_filled(r.center(), 3.0, Palette::ORANGE);
        ui.label(
            RichText::new("正在执行…")
                .size(12.5)
                .color(Palette::TEXT_SECONDARY),
        );
    });
}

/// 空状态里的示例提示药丸（点击返回 true）。
fn example_chip(ui: &mut Ui, label: &str) -> bool {
    let font = FontId::proportional(13.0);
    let galley = ui
        .ctx()
        .fonts(|f| f.layout_no_wrap(label.to_owned(), font.clone(), Palette::TEXT));
    let pad = vec2(14.0, 7.0);
    let size = galley.size() + pad * 2.0;
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let hovered = resp.hovered();
    let fill = if hovered {
        Palette::ACCENT.gamma_multiply(0.12)
    } else {
        Palette::CARD_BG
    };
    let fg = if hovered { Palette::ACCENT } else { Palette::TEXT };
    let painter = ui.painter();
    painter.rect(rect, Rounding::same(16.0), fill, Stroke::new(1.0, Palette::HAIRLINE));
    paint_centered(painter, rect.center(), label, font, fg);
    if hovered {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp.clicked()
}

// ───────────────────────────── 运行详情 ─────────────────────────────

impl ConsoleApp {
    fn view_run_detail(&mut self, ui: &mut Ui) {
        let Some(run) = self.selected_run().cloned() else {
            ui.add_space(60.0);
            ui.vertical_centered(|ui| {
                ui.label(
                    RichText::new("从左侧选择一条运行记录")
                        .size(15.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            });
            return;
        };

        let mark_mode = self.mark_mode;

        // 头部
        let rh = ui.scope(|ui| {
            ui.horizontal(|ui| {
                status_badge(ui, run.status);
                ui.add_space(6.0);
                ui.label(RichText::new(&run.run_id).size(16.0).strong().monospace());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ghost_button(ui, "在 Finder 中显示") && !mark_mode {
                        let _ = std::process::Command::new("open").arg(&run.dir).spawn();
                    }
                });
            });
        });
        self.tag("运行详情 · 头部", rh.response.rect);
        ui.add_space(4.0);
        ui.horizontal(|ui| {
            if let Some(t) = &run.started {
                ui.label(
                    RichText::new(format!("开始 {}", model::fmt_local(t)))
                        .size(12.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            }
            if let Some(t) = &run.ended {
                ui.label(
                    RichText::new(format!("· 结束 {}", model::fmt_local(t)))
                        .size(12.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            }
            if !run.capability.is_empty() {
                ui.label(
                    RichText::new(format!("· {}", run.capability))
                        .size(12.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            }
        });
        ui.add_space(12.0);

        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .stick_to_bottom(std::env::var("GW_SCROLL_BOTTOM").is_ok())
            .show(ui, |ui| {
                // 输入问题
                let ri = ui.scope(|ui| {
                    card(ui, |ui| {
                        ui.label(
                            RichText::new("输入")
                                .size(12.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                        ui.add_space(4.0);
                        let text = if run.text.is_empty() {
                            "(无输入文本)".to_owned()
                        } else {
                            run.text.clone()
                        };
                        ui.label(RichText::new(text).size(15.0));
                    });
                });
                self.tag("运行详情 · 输入", ri.response.rect);
                ui.add_space(12.0);

                ui.label(RichText::new("事件流").size(13.0).strong());
                ui.add_space(6.0);

                if run.events.is_empty() {
                    ui.label(
                        RichText::new("无事件")
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
                for ev in &run.events {
                    let re = ui.scope(|ui| event_card(ui, ev));
                    self.tag(&format!("事件卡片 #{} · {}", ev.seq, ev.kind), re.response.rect);
                    ui.add_space(8.0);
                }

                // 产物 / 资源：扫描运行工作区里的代码与图片，内联预览。
                if !run.artifacts.is_empty() {
                    ui.add_space(16.0);
                    ui.horizontal(|ui| {
                        ui.label(RichText::new("产物 / 资源").size(13.0).strong());
                        ui.label(
                            RichText::new(format!("{} 个文件", run.artifacts.len()))
                                .size(11.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                    });
                    ui.add_space(6.0);
                    for art in &run.artifacts {
                        let ra = ui.scope(|ui| artifact_card(ui, art, mark_mode));
                        self.tag(&format!("产物 · {}", art.rel), ra.response.rect);
                        ui.add_space(8.0);
                    }
                }
            });
    }
}

// ───────────────────────────── 日志视图 ─────────────────────────────

impl ConsoleApp {
    fn view_logs(&mut self, ui: &mut Ui) {
        ui.label(RichText::new("日志").size(22.0).strong());
        ui.add_space(2.0);

        let tailed = model::tail_log(&self.paths.launchd_log, 400);
        let panel_rect: Rect = match tailed {
            Some(lines) if !lines.is_empty() => {
                ui.label(
                    RichText::new(self.paths.launchd_log.to_string_lossy())
                        .size(11.0)
                        .monospace()
                        .color(Palette::TEXT_SECONDARY),
                );
                ui.add_space(10.0);
                ui.scope(|ui| log_panel(ui, &lines)).response.rect
            }
            _ => {
                ui.label(
                    RichText::new("未发现 launchd 日志文件，改为汇总各次运行的事件")
                        .size(12.0)
                        .color(Palette::TEXT_SECONDARY),
                );
                ui.add_space(10.0);
                ui.scope(|ui| activity_feed(ui, &self.runs)).response.rect
            }
        };
        self.tag("日志面板", panel_rect);
    }
}

// ───────────────────────────── 配置视图 ─────────────────────────────

impl ConsoleApp {
    fn view_config(&mut self, ui: &mut Ui) {
        ui.label(RichText::new("配置").size(22.0).strong());
        ui.add_space(8.0);

        let mut cfg_rect: Option<Rect> = None;
        match &self.config_cache {
            Some((text, is_example)) => {
                let path = if *is_example {
                    &self.paths.config_example
                } else {
                    &self.paths.config
                };
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(path.to_string_lossy())
                            .size(11.0)
                            .monospace()
                            .color(Palette::TEXT_SECONDARY),
                    );
                    if *is_example {
                        ui.label(
                            RichText::new("（示例 · config.json 不存在）")
                                .size(11.0)
                                .color(Palette::ORANGE),
                        );
                    }
                });
                ui.add_space(10.0);
                let rc = ui.scope(|ui| {
                    card(ui, |ui| {
                        egui::ScrollArea::vertical()
                            .auto_shrink([false, false])
                            .show(ui, |ui| {
                                highlighted_code(ui, text, "json", 12.5);
                            });
                    });
                });
                cfg_rect = Some(rc.response.rect);
            }
            None => {
                ui.label(
                    RichText::new("找不到 config.json 或 config.example.json")
                        .color(Palette::TEXT_SECONDARY),
                );
            }
        }
        if let Some(r) = cfg_rect {
            self.tag("配置 · JSON", r);
        }
    }
}

// ───────────────────────────── 可复用控件 ─────────────────────────────

/// 卡片容器：白底、发丝边、圆角、内边距。
fn card<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    egui::Frame::none()
        .fill(Palette::CARD_BG)
        .stroke(Stroke::new(1.0, Palette::HAIRLINE))
        .rounding(Rounding::same(10.0))
        .inner_margin(Margin::same(16.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .inner
}

/// 实心动作按钮：填充色 + 悬停加深 + 指针手势。
fn action_button(ui: &mut Ui, label: &str, fill: Color32, text: Color32) -> bool {
    button_impl(ui, label, fill, text, None)
}

/// 次级按钮：暖卡片底 + 发丝边，悬停略深。
fn ghost_button(ui: &mut Ui, label: &str) -> bool {
    button_impl(
        ui,
        label,
        Palette::CARD_BG,
        Palette::TEXT,
        Some(Palette::HAIRLINE),
    )
}

fn button_impl(
    ui: &mut Ui,
    label: &str,
    base: Color32,
    text_color: Color32,
    border: Option<Color32>,
) -> bool {
    let font = FontId::proportional(12.5);
    let galley = ui
        .ctx()
        .fonts(|f| f.layout_no_wrap(label.to_owned(), font, text_color));
    let pad = vec2(14.0, 7.0);
    let size = vec2((galley.size().x + pad.x * 2.0).max(48.0), 28.0);
    let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
    let hovered = resp.hovered();
    let fill = if hovered { darken(base, 0.93) } else { base };
    let stroke = border
        .map(|c| Stroke::new(1.0, if hovered { darken(c, 0.9) } else { c }))
        .unwrap_or(Stroke::NONE);
    // galley.size().y 是整行行高（含字体上下留白），中文 ascent/descent 不对称
    // 直接按行盒居中会偏上；用首行 glyph 的实际 ink 垂直范围来居中。
    let ink = galley_ink_y(&galley);
    let painter = ui.painter();
    painter.rect(rect, Rounding::same(7.0), fill, stroke);
    let x = rect.center().x - galley.size().x / 2.0;
    let y = rect.center().y - (ink.0 + ink.1) / 2.0;
    painter.galley(Pos2::new(x, y), galley, text_color);
    resp.on_hover_cursor(egui::CursorIcon::PointingHand).clicked()
}

/// 返回 galley 内文字 ink 的 (上沿, 下沿) y（相对 galley 顶部），用于真正的视觉垂直居中。
fn galley_ink_y(galley: &egui::Galley) -> (f32, f32) {
    let mut top = f32::INFINITY;
    let mut bottom = f32::NEG_INFINITY;
    for row in &galley.rows {
        for g in &row.glyphs {
            if g.uv_rect.size[1] == 0.0 {
                continue; // 空白字符无 ink
            }
            let it = g.pos.y + g.uv_rect.offset.y;
            top = top.min(it);
            bottom = bottom.max(it + g.uv_rect.size[1]);
        }
    }
    if top.is_finite() {
        (top, bottom)
    } else {
        (0.0, galley.size().y)
    }
}

/// 在 `center` 处绘制单行文字：水平居中 + 按 ink 真正视觉垂直居中。
/// egui 的 `Align2::CENTER_CENTER` / `ui.label` 居中的是整行行盒（含字体上下留白），
/// 中文 glyph 在行盒内 ink 偏上，直接居中会显得贴顶；这里按 ink 范围对齐。
fn paint_centered(painter: &egui::Painter, center: Pos2, label: &str, font: FontId, color: Color32) {
    let galley = painter.layout_no_wrap(label.to_owned(), font, color);
    let ink = galley_ink_y(&galley);
    let pos = Pos2::new(
        center.x - galley.size().x / 2.0,
        center.y - (ink.0 + ink.1) / 2.0,
    );
    painter.galley(pos, galley, color);
}

/// 自绘圆角徽标：背景填充 + ink 垂直居中的文字（替代 Frame+label，保证中文居中）。
fn painted_chip(ui: &mut Ui, label: &str, size: f32, fg: Color32, bg: Color32, rounding: f32, margin: egui::Vec2) {
    let galley = ui
        .ctx()
        .fonts(|f| f.layout_no_wrap(label.to_owned(), FontId::proportional(size), fg));
    let box_size = galley.size() + margin * 2.0;
    let (rect, _) = ui.allocate_exact_size(box_size, Sense::hover());
    let painter = ui.painter();
    painter.rect_filled(rect, Rounding::same(rounding), bg);
    paint_centered(painter, rect.center(), label, FontId::proportional(size), fg);
}

/// 颜色按比例调暗（用于悬停态）。
fn darken(c: Color32, f: f32) -> Color32 {
    Color32::from_rgb(
        (c.r() as f32 * f) as u8,
        (c.g() as f32 * f) as u8,
        (c.b() as f32 * f) as u8,
    )
}

/// 在选中元素上画珊瑚描边 + caption（元素名 / 尺寸 / 评论），供抓屏。
fn draw_annotation(painter: &egui::Painter, m: &Mark) {
    painter.rect_stroke(m.rect, Rounding::same(8.0), Stroke::new(2.5, Palette::ACCENT));
    let mut txt = format!("{}  ·  {}×{}", m.name, m.rect.width() as i32, m.rect.height() as i32);
    if !m.comment.is_empty() {
        txt = format!("{txt}  ·  {}", m.comment);
    }
    let galley = painter.layout_no_wrap(txt, FontId::proportional(12.0), Color32::WHITE);
    let pad = vec2(8.0, 4.0);
    let box_size = galley.size() + pad * 2.0;
    let mut min = Pos2::new(m.rect.left(), m.rect.top() - box_size.y - 4.0);
    if min.y < 2.0 {
        min.y = m.rect.bottom() + 4.0;
    }
    painter.rect_filled(
        Rect::from_min_size(min, box_size),
        Rounding::same(5.0),
        Palette::ACCENT,
    );
    painter.galley(min + pad, galley, Color32::WHITE);
}

/// 状态胶囊（工具栏内）。
fn status_pill(ui: &mut Ui, status: &Status) {
    let (dot, text) = if status.running {
        (Palette::GREEN, "运行中")
    } else {
        (Palette::GRAY, "已停止")
    };
    egui::Frame::none()
        .fill(Color32::from_rgb(239, 236, 228))
        .rounding(Rounding::same(11.0))
        .inner_margin(Margin::symmetric(10.0, 4.0))
        .show(ui, |ui| {
            ui.horizontal(|ui| {
                let (r, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
                ui.painter().circle_filled(r.center(), 4.0, dot);
                ui.label(RichText::new(text).size(12.0).color(Palette::TEXT));
                if let Some(pid) = status.pid {
                    ui.label(
                        RichText::new(format!("· PID {pid}"))
                            .size(11.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
                if let Some(up) = &status.uptime {
                    ui.label(
                        RichText::new(up)
                            .size(11.0)
                            .monospace()
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
            });
        });
}

/// 左侧导航行（自绘选中/悬停高亮）。
fn nav_row(ui: &mut Ui, selected: bool, icon: NavIcon, label: &str, badge: Option<usize>) -> bool {
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 34.0), Sense::click());
    let bg = if selected {
        Palette::ACCENT
    } else if resp.hovered() {
        Palette::ACCENT.gamma_multiply(0.12) // 暖珊瑚淡染
    } else {
        Color32::TRANSPARENT
    };
    if bg != Color32::TRANSPARENT {
        ui.painter().rect_filled(rect, Rounding::same(8.0), bg);
    }
    if resp.hovered() && !selected {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let fg = if selected { Color32::WHITE } else { Palette::TEXT };
    let painter = ui.painter();
    draw_nav_icon(painter, icon, rect.left_center() + vec2(15.0, 0.0), fg);
    painter.text(
        rect.left_center() + vec2(36.0, 0.0),
        Align2::LEFT_CENTER,
        label,
        FontId::proportional(13.5),
        fg,
    );
    if let Some(n) = badge {
        let badge_fg = if selected {
            Color32::from_white_alpha(220)
        } else {
            Palette::TEXT_SECONDARY
        };
        painter.text(
            rect.right_center() - vec2(12.0, 0.0),
            Align2::RIGHT_CENTER,
            n.to_string(),
            FontId::proportional(12.0),
            badge_fg,
        );
    }
    resp.clicked()
}

/// 自绘导航矢量图标（16px 视觉盒，居中于 c）。
fn draw_nav_icon(p: &egui::Painter, icon: NavIcon, c: Pos2, color: Color32) {
    let st = Stroke::new(1.6, color);
    match icon {
        NavIcon::Chat => {
            // 对话气泡：圆角外框 + 左下小尾巴 + 两个点
            let r = Rect::from_center_size(c + vec2(0.0, -1.5), vec2(15.0, 12.0));
            p.rect_stroke(r, Rounding::same(4.0), st);
            let tail = vec![
                Pos2::new(c.x - 4.5, r.bottom() - 1.0),
                Pos2::new(c.x - 6.5, r.bottom() + 4.0),
                Pos2::new(c.x + 0.5, r.bottom() - 1.0),
            ];
            p.add(egui::Shape::convex_polygon(tail, color, Stroke::NONE));
            p.circle_filled(Pos2::new(c.x - 3.5, r.center().y), 1.15, color);
            p.circle_filled(Pos2::new(c.x + 3.5, r.center().y), 1.15, color);
        }
        NavIcon::Overview => {
            // 仪表盘四宫格
            let s = 5.5;
            let g = 2.0;
            for (dx, dy) in [
                (-s - g / 2.0, -s - g / 2.0),
                (g / 2.0, -s - g / 2.0),
                (-s - g / 2.0, g / 2.0),
                (g / 2.0, g / 2.0),
            ] {
                let r = Rect::from_min_size(c + vec2(dx, dy), vec2(s, s));
                p.rect_filled(r, Rounding::same(1.6), color);
            }
        }
        NavIcon::Runs => {
            // 列表：左侧圆点 + 横线 ×3
            for i in -1..=1 {
                let y = c.y + i as f32 * 5.5;
                p.circle_filled(Pos2::new(c.x - 6.0, y), 1.5, color);
                p.line_segment([Pos2::new(c.x - 2.0, y), Pos2::new(c.x + 7.0, y)], st);
            }
        }
        NavIcon::Logs => {
            // 文档外框 + 内部短线
            let r = Rect::from_center_size(c, vec2(13.0, 15.0));
            p.rect_stroke(r, Rounding::same(2.5), st);
            let thin = Stroke::new(1.3, color);
            for (i, w) in [(-1.0, 5.0_f32), (0.0, 6.0), (1.0, 4.0)] {
                let y = c.y + i * 4.0;
                p.line_segment([Pos2::new(c.x - 3.0, y), Pos2::new(c.x - 3.0 + w, y)], thin);
            }
        }
        NavIcon::Config => {
            // 两条滑轨 + 旋钮（设置）
            let y1 = c.y - 4.0;
            let y2 = c.y + 4.0;
            p.line_segment([Pos2::new(c.x - 7.0, y1), Pos2::new(c.x + 7.0, y1)], st);
            p.line_segment([Pos2::new(c.x - 7.0, y2), Pos2::new(c.x + 7.0, y2)], st);
            p.circle_filled(Pos2::new(c.x + 2.5, y1), 2.6, color);
            p.circle_filled(Pos2::new(c.x - 2.5, y2), 2.6, color);
        }
    }
}

/// 运行记录列表中的一行。
fn run_list_row(ui: &mut Ui, run: &Run, selected: bool) -> bool {
    let (rect, resp) =
        ui.allocate_exact_size(vec2(ui.available_width(), 52.0), Sense::click());
    let inner = rect.shrink2(vec2(8.0, 3.0));
    let bg = if selected {
        Palette::ACCENT.gamma_multiply(0.14)
    } else if resp.hovered() {
        Palette::ACCENT.gamma_multiply(0.07)
    } else {
        Color32::TRANSPARENT
    };
    if bg != Color32::TRANSPARENT {
        ui.painter().rect_filled(inner, Rounding::same(8.0), bg);
    }
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let painter = ui.painter();
    // 选中态：左侧珊瑚强调条
    if selected {
        painter.rect_filled(
            egui::Rect::from_min_size(inner.left_top() + vec2(0.0, 6.0), vec2(3.0, inner.height() - 12.0)),
            Rounding::same(2.0),
            Palette::ACCENT,
        );
    }
    // 状态圆点
    painter.circle_filled(
        inner.left_top() + vec2(14.0, 14.0),
        4.0,
        status_color(run.status),
    );
    // 输入文本
    let text = if run.text.is_empty() {
        "(无输入文本)".to_owned()
    } else {
        run.text.clone()
    };
    painter.text(
        inner.left_top() + vec2(28.0, 14.0),
        Align2::LEFT_CENTER,
        truncate(&text, 26),
        FontId::proportional(13.5),
        Palette::TEXT,
    );
    // 第二行：时间 + run_id 尾段
    let sub = match &run.started {
        Some(t) => format!("{} · {}", model::fmt_local(t), short_id(&run.run_id)),
        None => short_id(&run.run_id),
    };
    painter.text(
        inner.left_top() + vec2(28.0, 34.0),
        Align2::LEFT_CENTER,
        sub,
        FontId::monospace(11.0),
        Palette::TEXT_SECONDARY,
    );
    resp.clicked()
}

/// 概览「最近运行」中的一行：整行可点、悬停淡染、行间发丝分隔。
fn recent_run_row(ui: &mut Ui, run: &Run, is_last: bool) -> bool {
    let (rect, resp) = ui.allocate_exact_size(vec2(ui.available_width(), 30.0), Sense::click());
    if resp.hovered() {
        ui.painter()
            .rect_filled(rect, Rounding::same(6.0), Palette::ACCENT.gamma_multiply(0.07));
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    let painter = ui.painter();
    painter.circle_filled(rect.left_center() + vec2(7.0, 0.0), 4.0, status_color(run.status));
    let text = if run.text.is_empty() {
        "(无输入文本)".to_owned()
    } else {
        run.text.clone()
    };
    painter.text(
        rect.left_center() + vec2(20.0, 0.0),
        Align2::LEFT_CENTER,
        truncate(&text, 44),
        FontId::proportional(13.0),
        Palette::TEXT,
    );
    if let Some(t) = &run.started {
        painter.text(
            rect.right_center() - vec2(6.0, 0.0),
            Align2::RIGHT_CENTER,
            model::fmt_local(t),
            FontId::monospace(11.0),
            Palette::TEXT_SECONDARY,
        );
    }
    if !is_last {
        painter.hline(
            rect.x_range(),
            rect.bottom(),
            Stroke::new(1.0, Palette::HAIRLINE.gamma_multiply(0.6)),
        );
    }
    resp.clicked()
}

/// 事件卡片（按 kind 上色）。
fn event_card(ui: &mut Ui, ev: &model::Event) {
    let (accent, label) = match ev.kind.as_str() {
        "result" => (Palette::GREEN, "结果"),
        "error" => (Palette::RED, "错误"),
        "progress" => (Palette::ACCENT, "进度"),
        "ask" => (Palette::ORANGE, "提问"),
        "signal" => (Palette::GRAY, "信号"),
        _ => (Palette::GRAY, "事件"),
    };
    egui::Frame::none()
        .fill(Palette::CARD_BG)
        .stroke(Stroke::new(1.0, Palette::HAIRLINE))
        .rounding(Rounding::same(9.0))
        .inner_margin(Margin::same(12.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                kind_chip(ui, label, accent);
                ui.label(
                    RichText::new(format!("#{}", ev.seq))
                        .size(11.0)
                        .monospace()
                        .color(Palette::TEXT_SECONDARY),
                );
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if let Some(t) = model::parse_iso_pub(&ev.at) {
                        ui.label(
                            RichText::new(model::fmt_local(&t))
                                .size(11.0)
                                .monospace()
                                .color(Palette::TEXT_SECONDARY),
                        );
                    }
                });
            });
            ui.add_space(6.0);
            match ev.kind.as_str() {
                "progress" => {
                    // 控制台默认显示原始工具调用（detail），无则退回叙述（status）。
                    if let Some(d) = ev.detail.as_deref() {
                        ui.add(
                            egui::Label::new(RichText::new(d).size(13.0).monospace()).wrap(),
                        );
                        if let Some(s) = ev.status.as_deref() {
                            ui.label(
                                RichText::new(s).size(11.5).color(Palette::TEXT_SECONDARY),
                            );
                        }
                    } else if let Some(s) = &ev.status {
                        ui.label(RichText::new(s).size(13.5));
                    }
                }
                "result" => {
                    if let Some(s) = &ev.summary {
                        // summary 是 LLM 输出的 Markdown，按 Markdown 渲染。
                        ui.push_id(ev.seq, |ui| {
                            MD_CACHE.with(|c| {
                                CommonMarkViewer::new().show(ui, &mut c.borrow_mut(), s);
                            });
                        });
                    }
                    if let Some(tables) = &ev.tables {
                        for t in tables {
                            ui.add_space(8.0);
                            render_table(ui, t);
                        }
                    }
                }
                "error" => {
                    if let Some(r) = &ev.reason {
                        ui.colored_label(Palette::RED, RichText::new(r).size(13.5));
                    }
                    if ev.retriable == Some(true) {
                        ui.label(
                            RichText::new("可重试")
                                .size(11.0)
                                .color(Palette::ORANGE),
                        );
                    }
                }
                "ask" => {
                    if let Some(p) = &ev.prompt {
                        ui.label(RichText::new(p).size(13.5));
                    }
                }
                _ => {}
            }
        });
}

fn render_table(ui: &mut Ui, t: &model::Table) {
    if let Some(title) = &t.title {
        if !title.is_empty() {
            ui.label(
                RichText::new(title)
                    .size(12.0)
                    .color(Palette::TEXT_SECONDARY)
                    .strong(),
            );
        }
    }
    let id = ui.make_persistent_id(("tbl", t.title.as_deref().unwrap_or(""), t.columns.len()));
    egui::Grid::new(id)
        .striped(true)
        .spacing(vec2(14.0, 4.0))
        .show(ui, |ui| {
            for c in &t.columns {
                ui.label(RichText::new(c).size(12.5).strong());
            }
            ui.end_row();
            for row in t.rows.iter().take(50) {
                for cell in row {
                    ui.label(RichText::new(cell_to_string(cell)).size(12.5));
                }
                ui.end_row();
            }
        });
    if t.rows.len() > 50 {
        ui.label(
            RichText::new(format!("… 其余 {} 行已省略", t.rows.len() - 50))
                .size(11.0)
                .color(Palette::TEXT_SECONDARY),
        );
    }
}

fn log_panel(ui: &mut Ui, lines: &[LogLine]) {
    // 固定列：时间｜级别｜模块｜消息。各行同列对齐、整行垂直居中、长消息裁剪。
    const TIME_X: f32 = 4.0;
    const LEVEL_X: f32 = 78.0;
    const MODULE_X: f32 = 130.0;
    const MSG_X: f32 = 228.0;
    const ROW_H: f32 = 21.0;
    let font = FontId::monospace(11.5);

    egui::Frame::none()
        .fill(Color32::from_rgb(38, 38, 36))
        .rounding(Rounding::same(10.0))
        .inner_margin(Margin::same(14.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            egui::ScrollArea::vertical()
                .auto_shrink([false, false])
                .stick_to_bottom(true)
                .show(ui, |ui| {
                    for l in lines {
                        let (rect, _) = ui
                            .allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::hover());
                        let cy = rect.left_center().y;
                        let painter = ui.painter();

                        // 非结构化行（npm 构建输出等）：整行作消息，跨满宽。
                        if l.level == "raw" {
                            painter.with_clip_rect(rect).text(
                                Pos2::new(rect.left() + TIME_X, cy),
                                Align2::LEFT_CENTER,
                                &l.msg,
                                font.clone(),
                                Color32::from_rgb(150, 148, 140),
                            );
                            continue;
                        }

                        if !l.ts.is_empty() {
                            painter.text(
                                Pos2::new(rect.left() + TIME_X, cy),
                                Align2::LEFT_CENTER,
                                short_time(&l.ts),
                                font.clone(),
                                Color32::from_rgb(130, 130, 138),
                            );
                        }
                        painter.text(
                            Pos2::new(rect.left() + LEVEL_X, cy),
                            Align2::LEFT_CENTER,
                            l.level.to_uppercase(),
                            font.clone(),
                            level_color(&l.level),
                        );
                        if !l.module.is_empty() {
                            let clip = Rect::from_min_max(
                                Pos2::new(rect.left() + MODULE_X, rect.top()),
                                Pos2::new(rect.left() + MSG_X - 8.0, rect.bottom()),
                            );
                            painter.with_clip_rect(clip).text(
                                Pos2::new(rect.left() + MODULE_X, cy),
                                Align2::LEFT_CENTER,
                                &l.module,
                                font.clone(),
                                Color32::from_rgb(150, 150, 158),
                            );
                        }
                        let clip = Rect::from_min_max(
                            Pos2::new(rect.left() + MSG_X, rect.top()),
                            Pos2::new(rect.right(), rect.bottom()),
                        );
                        painter.with_clip_rect(clip).text(
                            Pos2::new(rect.left() + MSG_X, cy),
                            Align2::LEFT_CENTER,
                            l.msg.replace('\n', " "),
                            font.clone(),
                            Color32::from_rgb(228, 228, 232),
                        );
                    }
                });
        });
}

fn activity_feed(ui: &mut Ui, runs: &[Run]) {
    // 固定列：时间｜类型｜内容｜run id。各行同列对齐、整行垂直居中。
    const TIME_X: f32 = 6.0;
    const KIND_X: f32 = 116.0;
    const KIND_W: f32 = 42.0;
    const DETAIL_X: f32 = 168.0;
    const RUNID_W: f32 = 64.0;
    const ROW_H: f32 = 26.0;

    card(ui, |ui| {
        egui::ScrollArea::vertical()
            .auto_shrink([false, false])
            .show(ui, |ui| {
                let mut idx = 0usize;
                for run in runs {
                    for ev in run.events.iter().rev() {
                        let (rect, _) = ui
                            .allocate_exact_size(vec2(ui.available_width(), ROW_H), Sense::hover());
                        // 斑马纹便于横向扫读
                        if idx % 2 == 1 {
                            ui.painter().rect_filled(
                                rect,
                                Rounding::same(5.0),
                                Palette::CARD_BG_ALT.gamma_multiply(0.6),
                            );
                        }
                        idx += 1;
                        let cy = rect.left_center().y;
                        let painter = ui.painter();

                        // 时间
                        let time = model::parse_iso_pub(&ev.at)
                            .map(|t| model::fmt_local(&t))
                            .unwrap_or_default();
                        painter.text(
                            Pos2::new(rect.left() + TIME_X, cy),
                            Align2::LEFT_CENTER,
                            time,
                            FontId::monospace(11.5),
                            Palette::TEXT_SECONDARY,
                        );

                        // 类型 chip（固定列宽，文本居中）
                        let (c, lbl) = match ev.kind.as_str() {
                            "result" => (Palette::GREEN, "结果"),
                            "error" => (Palette::RED, "错误"),
                            "progress" => (Palette::ACCENT, "进度"),
                            "ask" => (Palette::ORANGE, "提问"),
                            other => (Palette::GRAY, other),
                        };
                        let chip = Rect::from_min_size(
                            Pos2::new(rect.left() + KIND_X, cy - 9.0),
                            vec2(KIND_W, 18.0),
                        );
                        painter.rect_filled(chip, Rounding::same(5.0), c.gamma_multiply(0.16));
                        paint_centered(painter, chip.center(), lbl, FontId::proportional(11.5), c);

                        // 内容（裁剪到 run id 列之前，避免重叠）；progress 优先原始 detail
                        let detail = ev
                            .detail
                            .as_deref()
                            .or(ev.status.as_deref())
                            .or(ev.summary.as_deref())
                            .or(ev.reason.as_deref())
                            .unwrap_or("");
                        let detail_right = rect.right() - RUNID_W;
                        let clip = Rect::from_min_max(
                            Pos2::new(rect.left() + DETAIL_X, rect.top()),
                            Pos2::new(detail_right, rect.bottom()),
                        );
                        painter.with_clip_rect(clip).text(
                            Pos2::new(rect.left() + DETAIL_X, cy),
                            Align2::LEFT_CENTER,
                            detail.replace('\n', " "),
                            FontId::proportional(12.5),
                            Palette::TEXT,
                        );

                        // run id（右对齐）
                        painter.text(
                            Pos2::new(rect.right() - 4.0, cy),
                            Align2::RIGHT_CENTER,
                            short_id(&run.run_id),
                            FontId::monospace(10.5),
                            Palette::TEXT_SECONDARY,
                        );
                    }
                }
                if idx == 0 {
                    ui.label(RichText::new("暂无事件").color(Palette::TEXT_SECONDARY));
                }
            });
    });
}

fn kind_chip(ui: &mut Ui, label: &str, color: Color32) {
    painted_chip(ui, label, 11.5, color, color.linear_multiply(0.16), 5.0, vec2(7.0, 2.0));
}

fn status_badge(ui: &mut Ui, status: RunStatus) {
    let c = status_color(status);
    painted_chip(ui, status.label(), 12.5, c, c.linear_multiply(0.16), 6.0, vec2(9.0, 3.0));
}

fn stat_chip(ui: &mut Ui, label: &str, n: usize, color: Color32) {
    ui.horizontal(|ui| {
        let (r, _) = ui.allocate_exact_size(vec2(8.0, 8.0), Sense::hover());
        ui.painter().circle_filled(r.center(), 3.5, color);
        ui.label(
            RichText::new(format!("{label} {n}"))
                .size(12.0)
                .color(Palette::TEXT_SECONDARY),
        );
    });
}

fn kv_line(ui: &mut Ui, k: &str, v: &str) {
    ui.horizontal(|ui| {
        ui.label(
            RichText::new(k)
                .size(12.5)
                .color(Palette::TEXT_SECONDARY),
        );
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(RichText::new(v).size(12.5).strong());
        });
    });
}

// ───────────────────────────── 纯函数工具 ─────────────────────────────

fn status_color(s: RunStatus) -> Color32 {
    match s {
        RunStatus::Done => Palette::GREEN,
        RunStatus::Failed => Palette::RED,
        RunStatus::Running => Palette::ORANGE,
        RunStatus::Empty => Palette::GRAY,
    }
}

fn cell_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::Null => "—".into(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn truncate(s: &str, max_chars: usize) -> String {
    let cleaned: String = s.replace('\n', " ");
    let chars: Vec<char> = cleaned.chars().collect();
    if chars.len() <= max_chars {
        cleaned
    } else {
        let head: String = chars.into_iter().take(max_chars).collect();
        format!("{head}…")
    }
}

fn short_id(run_id: &str) -> String {
    run_id.rsplit('_').next().unwrap_or(run_id).to_owned()
}

fn short_time(ts: &str) -> String {
    // "2026-06-12T06:51:06.927Z" → "06:51:06"
    ts.split('T')
        .nth(1)
        .map(|t| t.split('.').next().unwrap_or(t).trim_end_matches('Z').to_owned())
        .unwrap_or_else(|| ts.to_owned())
}

fn level_color(level: &str) -> Color32 {
    match level {
        "error" => Color32::from_rgb(232, 132, 110), // 暖砖红
        "warn" => Color32::from_rgb(224, 178, 108),  // 琥珀
        "debug" => Color32::from_rgb(150, 148, 140),
        "raw" => Color32::from_rgb(150, 148, 140),
        _ => Color32::from_rgb(216, 156, 130), // info：暖珊瑚
    }
}

/// 从配置文本里提取 (并发上限, 超时, agent)。
fn parse_cfg(text: &str) -> (String, String, String) {
    let v: serde_json::Value = serde_json::from_str(text).unwrap_or(serde_json::Value::Null);
    let mc = v
        .pointer("/runtime/maxConcurrent")
        .map(|x| x.to_string())
        .unwrap_or_else(|| "?".into());
    let to = v
        .pointer("/runtime/timeoutSec")
        .map(|x| x.to_string())
        .unwrap_or_else(|| "?".into());
    let agent = v
        .pointer("/capability/runtime/agent")
        .and_then(|x| x.as_str())
        .unwrap_or("?")
        .to_owned();
    (mc, to, agent)
}

// ───────────────────────────── 产物 / 资源预览 ─────────────────────────────

/// 产物卡片：头部（类型 chip / 路径 / 大小 / 打开）+ 内联预览（图片 / 代码 / 占位）。
fn artifact_card(ui: &mut Ui, art: &model::Artifact, mark_mode: bool) {
    egui::Frame::none()
        .fill(Palette::CARD_BG)
        .stroke(Stroke::new(1.0, Palette::HAIRLINE))
        .rounding(Rounding::same(9.0))
        .inner_margin(Margin::same(12.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.horizontal(|ui| {
                let (color, label) = match art.kind {
                    model::ArtifactKind::Image => (Palette::ACCENT, "图片".to_owned()),
                    model::ArtifactKind::Code => {
                        let l = if art.ext.is_empty() {
                            "文本".to_owned()
                        } else {
                            art.ext.to_uppercase()
                        };
                        (Palette::GREEN, l)
                    }
                    model::ArtifactKind::Other => (Palette::GRAY, "文件".to_owned()),
                };
                kind_chip(ui, &label, color);
                ui.label(RichText::new(&art.rel).size(12.5).strong().monospace());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    if ghost_button(ui, "打开") && !mark_mode {
                        let _ = std::process::Command::new("open").arg(&art.path).spawn();
                    }
                    ui.add_space(8.0);
                    ui.label(
                        RichText::new(human_size(art.size))
                            .size(11.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                });
            });
            ui.add_space(8.0);
            match art.kind {
                model::ArtifactKind::Image => {
                    let avail = ui.available_width();
                    ui.add(
                        egui::Image::new(egui::ImageSource::Uri(
                            format!("file://{}", art.path.display()).into(),
                        ))
                        .max_height(320.0)
                        .max_width(avail)
                        .fit_to_original_size(1.0)
                        .rounding(Rounding::same(6.0)),
                    );
                }
                model::ArtifactKind::Code => match code_text(&art.path, art.size) {
                    Some((text, truncated)) => {
                        code_block(ui, &art.rel, &text, &art.ext, truncated)
                    }
                    None => {
                        ui.label(
                            RichText::new("无法读取该文件")
                                .size(12.0)
                                .color(Palette::TEXT_SECONDARY),
                        );
                    }
                },
                model::ArtifactKind::Other => {
                    ui.label(
                        RichText::new("二进制文件 · 点「打开」用系统默认程序查看")
                            .size(12.0)
                            .color(Palette::TEXT_SECONDARY),
                    );
                }
            }
        });
}

/// 语法高亮渲染：用 egui_extras（syntect 引擎）按语言着色，保留换行与可选中文本。
/// language 传扩展名（rs/py/json/sh…）或 syntax 名；未识别时回退暖灰纯文本。
fn highlighted_code(ui: &mut Ui, code: &str, language: &str, font_size: f32) {
    let theme = egui_extras::syntax_highlighting::CodeTheme::light(font_size);
    let mut job =
        egui_extras::syntax_highlighting::highlight(ui.ctx(), ui.style(), &theme, code, language);
    // 跟随容器宽度软换行，与原纯文本块的换行行为一致。
    job.wrap.max_width = ui.available_width();
    ui.add(egui::Label::new(job).selectable(true));
}

/// 代码/文本内容块：暖灰底、限高滚动、语法高亮换行；截断时给出提示。
/// lang 传文件扩展名（rs/py/json/sh…），交由 syntect 着色，未识别则回退纯文本。
fn code_block(ui: &mut Ui, id_src: &str, text: &str, lang: &str, truncated: bool) {
    egui::Frame::none()
        .fill(Palette::CARD_BG_ALT)
        .rounding(Rounding::same(7.0))
        .inner_margin(Margin::same(10.0))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            egui::ScrollArea::vertical()
                .id_salt(("code", id_src))
                .max_height(360.0)
                .auto_shrink([false, false])
                .show(ui, |ui| {
                    highlighted_code(ui, text, lang, 12.0);
                });
            if truncated {
                ui.add_space(4.0);
                ui.label(
                    RichText::new("… 内容过长已截断，点「打开」查看完整文件")
                        .size(11.0)
                        .color(Palette::TEXT_SECONDARY),
                );
            }
        });
}

/// 读取代码/文本产物（带按「路径+大小」键的缓存，避免每帧重读）。
fn code_text(path: &std::path::Path, size: u64) -> Option<(String, bool)> {
    let key = format!("{}:{}", path.display(), size);
    if let Some(v) = CODE_CACHE.with(|c| c.borrow().get(&key).cloned()) {
        return Some(v);
    }
    let v = model::read_text_preview(path)?;
    CODE_CACHE.with(|c| c.borrow_mut().insert(key, v.clone()));
    Some(v)
}

/// 字节数转人类可读（B / KB / MB）。
fn human_size(n: u64) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / 1024.0 / 1024.0)
    }
}
