//! 向常驻网关的控制台 HTTP 连接器提交查询（POST /query）。
//!
//! 极简 HTTP/1.1 客户端：只打本机回环、请求体小、响应短，手写避免引入 HTTP 依赖。
//! 在后台线程调用，结果经 channel 回传 UI 线程（见 app.rs）。

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

/// 提交结果：Ok 表示网关已受理（结果走文件系统回显）；Err(message) 为面向用户的失败原因。
pub enum QueryOutcome {
    Ok,
    Err(String),
}

/// 同步提交一次查询（阻塞，调用方应放后台线程）。
pub fn submit_query(host: &str, port: u16, text: &str) -> QueryOutcome {
    match post_query(host, port, text) {
        Ok(()) => QueryOutcome::Ok,
        Err(e) => QueryOutcome::Err(e),
    }
}

fn post_query(host: &str, port: u16, text: &str) -> Result<(), String> {
    let body = serde_json::json!({ "text": text }).to_string();
    let addr = format!("{host}:{port}");
    let mut stream = TcpStream::connect(&addr)
        .map_err(|e| format!("连不上网关 {addr}（确认服务已启动）：{e}"))?;
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    // 网关收到即入队并立即应答（不等执行），读超时给宽一点即可。
    stream.set_read_timeout(Some(Duration::from_secs(15))).ok();

    let req = format!(
        "POST /query HTTP/1.1\r\n\
         Host: {host}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        len = body.len(),
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送请求失败：{e}"))?;

    let mut resp = String::new();
    stream
        .read_to_string(&mut resp)
        .map_err(|e| format!("读取响应失败：{e}"))?;

    let code = resp
        .lines()
        .next()
        .and_then(|status| status.split_whitespace().nth(1))
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| "网关响应无法解析".to_string())?;
    let body_str = resp.split("\r\n\r\n").nth(1).unwrap_or("");
    let json: serde_json::Value = serde_json::from_str(body_str).unwrap_or(serde_json::Value::Null);

    if (200..300).contains(&code) {
        Ok(())
    } else {
        let msg = json
            .get("error")
            .and_then(|x| x.as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("网关返回 HTTP {code}"));
        Err(msg)
    }
}
