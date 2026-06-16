//! 设计审阅「标记」能力：选中界面元素 → 写评论 → 把带标注的截图拷到剪贴板。
//!
//! 即时模式 GUI 没有 DOM，所以「是哪个元素」靠各区域在绘制时登记语义名（见 app.rs 的
//! `tag()`）。截图复用 macOS `screencapture -R`（按屏幕点取矩形），`-c` 直接进剪贴板。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 被选中的标记目标。
#[derive(Clone, Debug)]
pub struct Mark {
    pub name: String,
    pub rect: eframe::egui::Rect, // egui 逻辑坐标（窗口内容系）
    pub comment: String,
}

/// 截图时序状态机：点「复制截图」后先让标注 overlay 上屏几帧，再抓屏。
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Capture {
    Idle,
    Armed(u8),
}

/// 把屏幕上一块矩形（点坐标）拷到剪贴板，并另存一份 PNG。返回存档路径。
pub fn capture_region(
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    dir: &Path,
    seq: usize,
) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let rect = format!("{},{},{},{}", x as i32, y as i32, w.max(1.0) as i32, h.max(1.0) as i32);

    // 进剪贴板
    let clip = Command::new("screencapture")
        .args(["-x", "-c", "-R", &rect])
        .status()
        .map_err(|e| e.to_string())?;
    if !clip.success() {
        return Err("screencapture -c 失败".into());
    }

    // 另存文件
    let file = dir.join(format!("mark-{seq}.png"));
    let _ = Command::new("screencapture")
        .args(["-x", "-R", &rect])
        .arg(&file)
        .status();
    Ok(file)
}
