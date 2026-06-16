//! 从文件系统读取网关的运行轨迹与配置（只读）。
//!
//! 数据源（service-gateway 约定）：
//!   abilities/data-analysis/outputs/<run_id>/task.json      —— 一次任务的输入与上下文
//!   abilities/data-analysis/outputs/<run_id>/events.ndjson  —— 该任务的事件流（progress/result/error/...）
//!   platform/service-gateway/config.json                    —— 运行配置（缺省时读 config.example.json）

use chrono::{DateTime, Local, NaiveDateTime, TimeZone, Utc};
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// 仓库内的关键路径，启动时发现一次。
#[derive(Clone, Debug)]
pub struct Paths {
    pub repo_root: PathBuf,
    pub outputs: PathBuf,
    pub sg_dir: PathBuf,
    pub config: PathBuf,
    pub config_example: PathBuf,
    pub marks: PathBuf,
    pub launchd_log: PathBuf,
}

impl Paths {
    pub fn discover() -> Self {
        // 本 crate 在 platform/console/。优先 SG_REPO 指向仓库根；
        // 否则由 console 目录上溯两级（platform/console → platform → 仓库根）。
        let console_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let repo_root = std::env::var("SG_REPO")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                console_dir
                    .parent()
                    .and_then(Path::parent)
                    .map(Path::to_path_buf)
                    .unwrap_or_else(|| PathBuf::from("."))
            });
        let home = std::env::var("HOME").unwrap_or_default();
        let sg_dir = repo_root.join("platform").join("service-gateway");
        Paths {
            outputs: repo_root.join("abilities").join("data-analysis").join("outputs"),
            config: sg_dir.join("config.json"),
            config_example: sg_dir.join("config.example.json"),
            sg_dir,
            // 标注截图存 console 本地（被 console 的 .gitignore /gw-marks 忽略），不回写仓库根
            marks: console_dir.join("gw-marks"),
            launchd_log: PathBuf::from(home).join("Library/Logs/service-gateway/out.log"),
            repo_root,
        }
    }
}

/// task.json 的最小投影。
#[derive(Deserialize, Default)]
struct TaskInput {
    #[serde(default)]
    text: String,
}
#[derive(Deserialize, Default)]
struct TaskFile {
    #[serde(default)]
    capability: String,
    #[serde(default)]
    input: TaskInput,
}

/// events.ndjson 的一行；按 kind 取用对应字段。
#[derive(Deserialize, Clone, Debug)]
pub struct Event {
    #[serde(default)]
    pub seq: i64,
    #[serde(default)]
    pub at: String,
    pub kind: String,
    #[serde(default)]
    pub status: Option<String>, // progress（给 IM 的叙述）
    #[serde(default)]
    pub detail: Option<String>, // progress 原始工具调用 title（控制台默认显示这个）
    #[serde(default)]
    pub summary: Option<String>, // result
    #[serde(default)]
    pub reason: Option<String>, // error
    #[serde(default)]
    pub retriable: Option<bool>, // error
    #[serde(default)]
    pub prompt: Option<String>, // ask
    #[serde(default)]
    pub tables: Option<Vec<Table>>, // result
}

#[derive(Deserialize, Clone, Debug)]
pub struct Table {
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub columns: Vec<String>,
    #[serde(default)]
    pub rows: Vec<Vec<serde_json::Value>>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RunStatus {
    Done,
    Failed,
    Running,
    Empty,
}

impl RunStatus {
    pub fn label(self) -> &'static str {
        match self {
            RunStatus::Done => "完成",
            RunStatus::Failed => "失败",
            RunStatus::Running => "进行中",
            RunStatus::Empty => "无事件",
        }
    }
}

/// 运行工作区里的一个产物文件（代码 / 图片 / 其他）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ArtifactKind {
    Image,
    Code,
    Other,
}

#[derive(Clone, Debug)]
pub struct Artifact {
    pub path: PathBuf,    // 绝对路径
    pub rel: String,      // 相对 run 根的展示路径
    pub kind: ArtifactKind,
    pub size: u64,
    pub ext: String,      // 小写扩展名（语言标注用）
}

/// 一次完整的运行轨迹。
#[derive(Clone, Debug)]
pub struct Run {
    pub run_id: String,
    pub dir: PathBuf,
    pub text: String,
    pub capability: String,
    pub status: RunStatus,
    pub started: Option<DateTime<Utc>>,
    pub ended: Option<DateTime<Utc>>,
    pub events: Vec<Event>,
    pub artifacts: Vec<Artifact>,
}

/// 把 run_id 里的时间戳（run_20260612T065102Z_xxxx）解析为 UTC 时间。
fn parse_run_id_time(run_id: &str) -> Option<DateTime<Utc>> {
    let stamp = run_id.strip_prefix("run_")?;
    let stamp = stamp.split('_').next()?; // 去掉随机后缀
    let naive = NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%SZ").ok()?;
    Some(Utc.from_utc_datetime(&naive))
}

fn parse_iso(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.with_timezone(&Utc))
}

/// 供 UI 解析事件时间戳用。
pub fn parse_iso_pub(s: &str) -> Option<DateTime<Utc>> {
    parse_iso(s)
}

/// 扫描 outputs/ 下所有 run_* 目录，按时间倒序返回。
pub fn load_runs(outputs: &Path) -> Vec<Run> {
    let mut runs = Vec::new();
    let Ok(entries) = std::fs::read_dir(outputs) else {
        return runs;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.starts_with("run_") {
            continue;
        }
        if !entry.path().is_dir() {
            continue;
        }
        runs.push(load_run(&entry.path(), name));
    }
    // run_id 内嵌时间戳，字典序即时间序；倒序最新在前。
    runs.sort_by(|a, b| b.run_id.cmp(&a.run_id));
    runs
}

fn load_run(dir: &Path, run_id: String) -> Run {
    // 簿记文件现落在 .gateway/ 子目录（run 根是 agent 工作区）；
    // 旧 run 直接落在 run 根，故 .gateway/ 缺失时回退到根目录。
    let gw = dir.join(".gateway");
    let bookkeeping = if gw.join("task.json").exists() || gw.join("events.ndjson").exists() {
        gw
    } else {
        dir.to_path_buf()
    };

    let task: TaskFile = std::fs::read_to_string(bookkeeping.join("task.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let mut events = Vec::new();
    if let Ok(content) = std::fs::read_to_string(bookkeeping.join("events.ndjson")) {
        for line in content.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Ok(ev) = serde_json::from_str::<Event>(line) {
                events.push(ev);
            }
        }
    }
    events.sort_by_key(|e| e.seq);

    let status = match events.last().map(|e| e.kind.as_str()) {
        Some("result") => RunStatus::Done,
        Some("error") => RunStatus::Failed,
        Some(_) => RunStatus::Running,
        None => RunStatus::Empty,
    };

    let started = parse_run_id_time(&run_id)
        .or_else(|| events.first().and_then(|e| parse_iso(&e.at)));
    let ended = events.last().and_then(|e| parse_iso(&e.at));

    // run 根即 agent 工作区，扫描其中的产物文件（代码 / 图片 / 其他）。
    // 簿记落在根目录的旧 run，跳过 task.json / events.ndjson。
    let artifacts = scan_artifacts(dir, bookkeeping.as_path() == dir);

    Run {
        run_id,
        dir: dir.to_path_buf(),
        text: task.input.text,
        capability: task.capability,
        status,
        started,
        ended,
        events,
        artifacts,
    }
}

const MAX_ARTIFACTS: usize = 120;
const MAX_SCAN_DEPTH: u32 = 3;

/// 按文件名 / 扩展名把产物归类为图片、代码（含纯文本）、或其他二进制。
fn classify(name: &str, ext: &str) -> ArtifactKind {
    match ext {
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "ico" | "tif" | "tiff" => {
            ArtifactKind::Image
        }
        "rs" | "py" | "sql" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "jsx" | "json" | "jsonl"
        | "ndjson" | "md" | "markdown" | "csv" | "tsv" | "txt" | "log" | "sh" | "bash" | "zsh"
        | "fish" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "env" | "properties"
        | "html" | "htm" | "css" | "scss" | "sass" | "less" | "xml" | "svg" | "c" | "h" | "cpp"
        | "cc" | "hpp" | "go" | "java" | "kt" | "kts" | "rb" | "php" | "swift" | "vue" | "r"
        | "jl" | "lua" | "pl" | "tex" => ArtifactKind::Code,
        "" => {
            // 无扩展名的常见文本文件
            let lower = name.to_lowercase();
            if matches!(
                lower.as_str(),
                "dockerfile" | "makefile" | "readme" | "license" | "gitignore" | "npmrc"
            ) {
                ArtifactKind::Code
            } else {
                ArtifactKind::Other
            }
        }
        _ => ArtifactKind::Other,
    }
}

fn kind_rank(k: ArtifactKind) -> u8 {
    match k {
        ArtifactKind::Image => 0,
        ArtifactKind::Code => 1,
        ArtifactKind::Other => 2,
    }
}

/// 深度受限地遍历 run 工作区，收集产物文件（跳过隐藏项与 .gateway 簿记）。
fn scan_artifacts(run_root: &Path, skip_bookkeeping_at_root: bool) -> Vec<Artifact> {
    let mut out = Vec::new();
    let mut stack = vec![(run_root.to_path_buf(), 0u32)];
    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_ARTIFACTS {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            if out.len() >= MAX_ARTIFACTS {
                break;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue; // 跳过 .gateway 等隐藏项
            }
            let path = e.path();
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                if depth < MAX_SCAN_DEPTH {
                    stack.push((path, depth + 1));
                }
                continue;
            }
            if skip_bookkeeping_at_root
                && depth == 0
                && (name == "task.json" || name == "events.ndjson")
            {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            let rel = path
                .strip_prefix(run_root)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned();
            out.push(Artifact {
                kind: classify(&name, &ext),
                rel,
                size,
                ext,
                path,
            });
        }
    }
    // 图片优先、再代码、再其他；同类按相对路径，保证渲染顺序稳定。
    out.sort_by(|a, b| kind_rank(a.kind).cmp(&kind_rank(b.kind)).then(a.rel.cmp(&b.rel)));
    out
}

/// 读取文本/代码产物用于预览。返回 (内容, 是否被截断)；大文件按字节与字符双重设限。
pub fn read_text_preview(path: &Path) -> Option<(String, bool)> {
    use std::io::Read;
    let f = std::fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    f.take(4_000_000).read_to_end(&mut buf).ok()?;
    let mut truncated = buf.len() >= 4_000_000;
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if text.chars().count() > 40_000 {
        text = text.chars().take(40_000).collect();
        truncated = true;
    }
    Some((text, truncated))
}

/// 读取生效的配置文本（优先 config.json，回退 config.example.json）。返回 (内容, 是否为示例)。
pub fn load_config_text(paths: &Paths) -> Option<(String, bool)> {
    if let Ok(s) = std::fs::read_to_string(&paths.config) {
        return Some((s, false));
    }
    std::fs::read_to_string(&paths.config_example).ok().map(|s| (s, true))
}

/// 把 UTC 时间格式化为本地时区的短串。
pub fn fmt_local(dt: &DateTime<Utc>) -> String {
    dt.with_timezone(&Local).format("%m-%d %H:%M:%S").to_string()
}

/// 读取 launchd 日志文件的末尾若干行，逐行解析为 NDJSON 日志记录。
#[derive(Clone, Debug)]
pub struct LogLine {
    pub ts: String,
    pub level: String,
    pub module: String,
    pub msg: String,
}

pub fn tail_log(path: &Path, max_lines: usize) -> Option<Vec<LogLine>> {
    let content = std::fs::read_to_string(path).ok()?;
    let mut out = Vec::new();
    for line in content.lines().rev().take(max_lines) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let v: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => {
                // 非 JSON 行（如 npm 的构建输出）原样展示。
                out.push(LogLine {
                    ts: String::new(),
                    level: "raw".into(),
                    module: String::new(),
                    msg: line.to_owned(),
                });
                continue;
            }
        };
        out.push(LogLine {
            ts: v.get("ts").and_then(|x| x.as_str()).unwrap_or("").to_owned(),
            level: v.get("level").and_then(|x| x.as_str()).unwrap_or("info").to_owned(),
            module: v.get("module").and_then(|x| x.as_str()).unwrap_or("").to_owned(),
            msg: v.get("msg").and_then(|x| x.as_str()).unwrap_or("").to_owned(),
        });
    }
    out.reverse(); // 最新在底部
    Some(out)
}
