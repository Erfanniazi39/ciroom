//! Android Connect screen: "is CiRoom answering at this address?"
//!
//! Done here, not with `fetch()` in the bundled page: the PC's server sends no CORS headers (and refuses
//! cross-origin POSTs by design), so a page served from the app could not read its answer. This asks
//! `GET /api/remote/me` over plain HTTP; that route is open to any phone on the LAN (no pairing needed) and
//! answers `{"enabled":<bool>,"paired":<bool>}`, which no other program does.
//!
//! Only private IPv4 addresses (10.x, 172.16-31.x, 192.168.x) are ever contacted.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(3);

/// What the check found. Serialized as a lowercase word for the page.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PcStatus {
    /// CiRoom answers and the phone remote is on.
    Ok,
    /// CiRoom answers but its phone remote is off.
    Off,
    /// Nothing answers (closed, wrong address, other Wi-Fi, firewall).
    Unreachable,
    /// Something answers, but it isn't CiRoom.
    Other,
}

/// Reads an HTTP response and decides what it means.
pub fn classify(response: &str) -> PcStatus {
    let Some((head, body)) = response.split_once("\r\n\r\n") else { return PcStatus::Other };
    let status = head.lines().next().unwrap_or("");
    if !status.starts_with("HTTP/1.") || !status.contains(" 200") {
        return PcStatus::Other;
    }
    let Ok(json) = serde_json::from_str::<serde_json::Value>(body.trim()) else { return PcStatus::Other };
    match (json.get("enabled").and_then(|v| v.as_bool()), json.get("paired").and_then(|v| v.as_bool())) {
        (Some(true), Some(_)) => PcStatus::Ok,
        (Some(false), Some(_)) => PcStatus::Off,
        _ => PcStatus::Other,
    }
}

/// One try. `host` must be a private IPv4 address.
pub fn check(host: &str, port: u16) -> PcStatus {
    let Ok(ip) = host.parse::<Ipv4Addr>() else { return PcStatus::Other };
    if !ip.is_private() || port == 0 {
        return PcStatus::Other;
    }
    let addr = SocketAddr::from((ip, port));
    let Ok(mut stream) = TcpStream::connect_timeout(&addr, TIMEOUT) else { return PcStatus::Unreachable };
    let _ = stream.set_read_timeout(Some(TIMEOUT));
    let _ = stream.set_write_timeout(Some(TIMEOUT));
    let request = format!("GET /api/remote/me HTTP/1.1\r\nHost: {ip}:{port}\r\nConnection: close\r\nAccept: application/json\r\n\r\n");
    if stream.write_all(request.as_bytes()).is_err() {
        return PcStatus::Unreachable;
    }
    let mut buf = Vec::new();
    // `take`: a server that never stops talking can't grow this without limit.
    let _ = stream.take(16 * 1024).read_to_end(&mut buf);
    if buf.is_empty() {
        return PcStatus::Unreachable;
    }
    classify(&String::from_utf8_lossy(&buf))
}

/// The page calls this before opening the PC's page.
#[tauri::command]
pub async fn check_pc(host: String, port: u16) -> Result<PcStatus, String> {
    tauri::async_runtime::spawn_blocking(move || check(&host, port)).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ciroom_with_remote_on_is_ok() {
        assert_eq!(classify("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"enabled\":true,\"paired\":false}"), PcStatus::Ok);
    }

    #[test]
    fn ciroom_with_remote_off_is_off() {
        assert_eq!(classify("HTTP/1.1 200 OK\r\n\r\n{\"enabled\":false,\"paired\":false}"), PcStatus::Off);
    }

    #[test]
    fn other_servers_are_other() {
        assert_eq!(classify("HTTP/1.1 404 Not Found\r\n\r\nnope"), PcStatus::Other);
        assert_eq!(classify("HTTP/1.1 200 OK\r\n\r\n<html>router login</html>"), PcStatus::Other);
        assert_eq!(classify("HTTP/1.1 200 OK\r\n\r\n{\"enabled\":\"yes\"}"), PcStatus::Other);
        assert_eq!(classify("garbage"), PcStatus::Other);
    }

    #[test]
    fn public_and_odd_addresses_are_never_contacted() {
        assert_eq!(check("8.8.8.8", 80), PcStatus::Other);
        assert_eq!(check("example.com", 80), PcStatus::Other);
        assert_eq!(check("127.0.0.1", 80), PcStatus::Other);
        assert_eq!(check("100.64.0.1", 80), PcStatus::Other);
        assert_eq!(check("192.168.1.20", 0), PcStatus::Other);
    }
}
