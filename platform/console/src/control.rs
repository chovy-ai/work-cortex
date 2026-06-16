//! 网关进程的探测与启停（通过 shell 工具，不依赖 launchd 是否已安装）。

use std::path::Path;
use std::process::Command;

/// 网关进程的当前状态。
#[derive(Clone, Debug, Default)]
pub struct Status {
    pub running: bool,
    pub pid: Option<u32>,
    pub uptime: Option<String>,
}

/// 通过 `pgrep -f dist/service.js` 探测网关进程。
pub fn probe() -> Status {
    let out = Command::new("pgrep").args(["-f", "dist/service.js"]).output();
    let pid = match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u32>().ok()),
        _ => None,
    };
    let uptime = pid.and_then(uptime_of);
    Status {
        running: pid.is_some(),
        pid,
        uptime,
    }
}

/// `ps -o etime= -p <pid>` 取进程运行时长（如 "01:23:45"）。
fn uptime_of(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "etime=", "-p", &pid.to_string()])
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 向网关进程发送 SIGTERM。
pub fn stop(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("kill {pid} 返回非零"))
    }
}

/// 以 detached 方式启动网关：`nohup npm start` 于 service-gateway 目录，
/// 输出追加到 launchd 日志文件，使「日志」视图能读取实时输出。
pub fn start(sg_dir: &Path, log_path: &Path) -> Result<(), String> {
    let log_dir = log_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "无法确定日志目录".to_string())?;
    let script = format!(
        "mkdir -p {log_dir} && cd {sg} && nohup npm start >> {log} 2>&1 &",
        log_dir = shell_quote(&log_dir.to_string_lossy()),
        sg = shell_quote(&sg_dir.to_string_lossy()),
        log = shell_quote(&log_path.to_string_lossy()),
    );
    let status = Command::new("/bin/sh")
        .arg("-c")
        .arg(&script)
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err("启动脚本返回非零".into())
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
