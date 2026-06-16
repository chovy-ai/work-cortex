//! macOS 风格的浅色主题 + 系统字体（SF Pro / SF Mono / 中文回退）。

use std::path::PathBuf;

use eframe::egui::{
    self, Color32, FontData, FontDefinitions, FontFamily, Rounding, Stroke, Style, Visuals,
};

/// Claude / Anthropic 品牌色板：暖米白底 + 赤陶珊瑚强调色 + 暖灰文字与边框。
pub struct Palette;
impl Palette {
    pub const ACCENT: Color32 = Color32::from_rgb(217, 119, 87); // Claude clay/coral #D97757
    pub const GREEN: Color32 = Color32::from_rgb(94, 153, 106); // 暖绿（完成）
    pub const RED: Color32 = Color32::from_rgb(194, 74, 60); // 砖红（失败）#C24A3C
    pub const ORANGE: Color32 = Color32::from_rgb(209, 137, 60); // 琥珀（进行中/重启）
    pub const GRAY: Color32 = Color32::from_rgb(140, 138, 131); // 暖灰

    pub const WINDOW_BG: Color32 = Color32::from_rgb(250, 249, 245); // ivory #FAF9F5
    pub const SIDEBAR_BG: Color32 = Color32::from_rgb(240, 238, 230); // 略深暖米 #F0EEE6
    pub const TOOLBAR_BG: Color32 = Color32::from_rgb(240, 238, 230);
    pub const CARD_BG: Color32 = Color32::from_rgb(255, 254, 251); // 近白暖卡片
    pub const CARD_BG_ALT: Color32 = Color32::from_rgb(245, 243, 236); // #F5F3EC

    pub const TEXT: Color32 = Color32::from_rgb(38, 37, 34); // 暖近黑 #262522
    pub const TEXT_SECONDARY: Color32 = Color32::from_rgb(115, 114, 108); // 暖次级灰
    pub const HAIRLINE: Color32 = Color32::from_rgb(231, 228, 218); // 暖发丝边 #E7E4DA
}

fn envf(key: &str, default: f32) -> f32 {
    std::env::var(key).ok().and_then(|s| s.parse().ok()).unwrap_or(default)
}

/// 找中文字体。注意：苹方 PingFang.ttc 虽能被 ab_glyph 解析，但其 AAT 字形
/// egui/ab_glyph **渲染不出**（中文会变空白），故用同为苹果系统自带、可正常
/// 光栅化的 Hiragino Sans GB（黑体）；再退 STHeiti。
fn find_cjk_path() -> Option<PathBuf> {
    for f in [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
    ] {
        if std::path::Path::new(f).exists() {
            return Some(f.into());
        }
    }
    None
}

/// 加载字体并设置基线/字号微调（用于对齐混排）。
fn tweaked(bytes: Vec<u8>, scale: f32, y_offset_factor: f32) -> FontData {
    let mut fd = FontData::from_owned(bytes);
    fd.tweak = egui::FontTweak {
        scale,
        y_offset_factor,
        ..Default::default()
    };
    fd
}

/// 加载 macOS 系统字体；找不到时静默回退到 egui 内建字体。
pub fn install_fonts(ctx: &egui::Context) {
    let mut fonts = FontDefinitions::default();

    let mut loaded_latin = false;
    let mut loaded_mono = false;
    let mut loaded_cjk = false;

    // 保持苹果原生 SF 字号（scale=1.0，不缩放、不变形）；仅用 y_offset 把 SF 的
    // 基线上移与中文对齐——等同系统合成 SF+中文时的纵向定位。可用 env 覆盖。
    let sf_scale = envf("GW_SF_SCALE", 1.0);
    let sf_dy = envf("GW_SF_DY", -0.06);

    if let Ok(bytes) = std::fs::read("/System/Library/Fonts/SFNS.ttf") {
        fonts
            .font_data
            .insert("sf-pro".to_owned(), tweaked(bytes, sf_scale, sf_dy));
        loaded_latin = true;
    }
    if let Ok(bytes) = std::fs::read("/System/Library/Fonts/SFNSMono.ttf") {
        fonts
            .font_data
            .insert("sf-mono".to_owned(), FontData::from_owned(bytes));
        loaded_mono = true;
    }
    if let Some(path) = find_cjk_path() {
        if let Ok(bytes) = std::fs::read(&path) {
            fonts
                .font_data
                .insert("cjk".to_owned(), FontData::from_owned(bytes));
            loaded_cjk = true;
        }
    }

    // 比例字体族：统一用 Hiragino 一套字体画拉丁字母 + 汉字，消除 SF↔中文混排接缝
    // （Hiragino 自带 ASCII 字形，同一字体内基线天然对齐，无需 y_offset 微调）；
    // SF Pro 仅留作 Hiragino 缺字时的兜底，正常正文不会命中，故不产生混排。
    let prop = fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default();
    let mut prop_chain = Vec::new();
    if loaded_cjk {
        prop_chain.push("cjk".to_owned());
    }
    if loaded_latin {
        prop_chain.push("sf-pro".to_owned()); // 兜底：Hiragino 缺的稀有符号
    }
    prop_chain.extend(prop.drain(..)); // 内建兜底
    *prop = prop_chain;

    // 等宽字体族：SF Mono 优先，中文同样回退到 Hiragino。
    let mono = fonts.families.entry(FontFamily::Monospace).or_default();
    let mut mono_chain = Vec::new();
    if loaded_mono {
        mono_chain.push("sf-mono".to_owned());
    }
    if loaded_cjk {
        mono_chain.push("cjk".to_owned());
    }
    mono_chain.extend(mono.drain(..));
    *mono = mono_chain;

    ctx.set_fonts(fonts);
}

/// 应用 macOS 浅色视觉规范：圆角、发丝分隔线、系统蓝选中色、克制的阴影。
pub fn install_style(ctx: &egui::Context) {
    let mut visuals = Visuals::light();

    visuals.override_text_color = Some(Palette::TEXT);
    visuals.panel_fill = Palette::WINDOW_BG;
    visuals.window_fill = Palette::WINDOW_BG;
    visuals.extreme_bg_color = Palette::CARD_BG_ALT; // 文本输入背景
    visuals.faint_bg_color = Palette::CARD_BG_ALT;
    visuals.hyperlink_color = Palette::ACCENT;

    visuals.selection.bg_fill = Palette::ACCENT.linear_multiply(0.20);
    visuals.selection.stroke = Stroke::new(1.0, Palette::ACCENT);

    let rounding = Rounding::same(6.0);
    visuals.widgets.noninteractive.rounding = rounding;
    visuals.widgets.inactive.rounding = rounding;
    visuals.widgets.hovered.rounding = rounding;
    visuals.widgets.active.rounding = rounding;
    visuals.widgets.open.rounding = rounding;

    // 普通控件：暖白填充、暖发丝描边。
    visuals.widgets.inactive.bg_fill = Palette::CARD_BG;
    visuals.widgets.inactive.weak_bg_fill = Palette::CARD_BG_ALT;
    visuals.widgets.inactive.bg_stroke = Stroke::new(1.0, Palette::HAIRLINE);
    visuals.widgets.inactive.fg_stroke = Stroke::new(1.0, Palette::TEXT);

    visuals.widgets.hovered.weak_bg_fill = Color32::from_rgb(238, 235, 227);
    visuals.widgets.hovered.bg_stroke = Stroke::new(1.0, Palette::HAIRLINE);
    visuals.widgets.hovered.fg_stroke = Stroke::new(1.0, Palette::TEXT);

    visuals.widgets.active.weak_bg_fill = Color32::from_rgb(231, 227, 217);
    visuals.widgets.active.bg_stroke = Stroke::new(1.0, Palette::ACCENT);

    visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0, Palette::HAIRLINE);

    visuals.window_rounding = Rounding::same(10.0);
    visuals.window_stroke = Stroke::new(1.0, Palette::HAIRLINE);
    visuals.popup_shadow.color = Color32::from_black_alpha(40);
    visuals.window_shadow.color = Color32::from_black_alpha(50);

    let mut style = Style {
        visuals,
        ..Default::default()
    };
    style.spacing.item_spacing = egui::vec2(8.0, 8.0);
    style.spacing.button_padding = egui::vec2(12.0, 6.0);
    style.spacing.window_margin = egui::Margin::same(0.0);

    ctx.set_style(style);
}
