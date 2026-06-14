// Service Gateway 控制台 —— macOS 风格的桌面监控 GUI（egui / eframe）。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod control;
mod mark;
mod model;
mod query;
mod theme;

use eframe::egui;

fn main() -> eframe::Result<()> {
    let size = std::env::var("GW_SIZE")
        .ok()
        .and_then(|s| {
            let (w, h) = s.split_once(',')?;
            Some([w.trim().parse::<f32>().ok()?, h.trim().parse::<f32>().ok()?])
        })
        .unwrap_or([1120.0, 740.0]);
    let mut viewport = egui::ViewportBuilder::default()
        .with_inner_size(size)
        .with_min_inner_size([860.0, 560.0])
        .with_title("Service Gateway 控制台");
    // 可选：用 GW_POS=x,y 指定窗口初始位置（仅用于截图取景）。
    if let Ok(pos) = std::env::var("GW_POS") {
        if let Some((x, y)) = pos.split_once(',') {
            if let (Ok(x), Ok(y)) = (x.trim().parse::<f32>(), y.trim().parse::<f32>()) {
                viewport = viewport.with_position([x, y]);
            }
        }
    }
    let options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "Service Gateway 控制台",
        options,
        Box::new(|cc| {
            theme::install_fonts(&cc.egui_ctx);
            theme::install_style(&cc.egui_ctx);
            // 注册图片加载器（file:// + 解码），供运行产物里的图片资源预览。
            egui_extras::install_image_loaders(&cc.egui_ctx);
            Ok(Box::new(app::ConsoleApp::new()))
        }),
    )
}
