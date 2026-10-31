#[cfg(not(target_os = "windows"))]
use std::collections::HashMap;
use stellar_core::domain::{AppError, ConnectionSnapshot};
#[cfg(not(target_os = "windows"))]
use stellar_core::{domain::ConnectionStatus, ports::VpnEngine, openvpn::{VpnCredentials, ValidatedConfig}};
#[cfg(target_os = "windows")]
pub use super::windows_vpn::OpenVpnEngine;
#[cfg(not(target_os = "windows"))]
pub struct OpenVpnEngine { credentials: Option<VpnCredentials>, configurations: HashMap<String, ValidatedConfig>, connected: bool, expires_at: u64, traffic: Option<(std::time::Instant, u64, u64)>, kill_switch: bool, firewall_supported: bool }
#[cfg(not(target_os = "windows"))]
impl Default for OpenVpnEngine {
    fn default() -> Self {
        Self { credentials: None, configurations: HashMap::new(), connected: false, expires_at: 0, traffic: None, kill_switch: false, firewall_supported: firewall_supported() }
    }
}
#[cfg(not(target_os = "windows"))]
fn firewall_supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        use std::io::{BufRead, Read, Write};
        let Ok(mut stream) = helper() else { return false; };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(1)));
        if stream.write_all(b"CAPABILITIES\n").is_err() { return false; }
        let mut line = String::new();
        return std::io::BufReader::new(stream).take(128).read_line(&mut line).is_ok() && matches!(line.trim(), "CAPABILITIES 2 kill-switch" | "CAPABILITIES 3 kill-switch live-kill-switch");
    }
    #[cfg(not(target_os = "macos"))]
    false
}
/// Read-only setup check: no firewall changes, credentials, installers or shell.
pub fn installation_check() -> (&'static str, bool) {
    #[cfg(target_os = "windows")]
    { return super::windows_vpn::installation_check(); }
    #[cfg(target_os = "macos")]
    {
        use std::io::{BufRead, Read, Write};
        if !std::path::Path::new("/Library/Application Support/Stellar VPN/stellar-vpn-helper").is_file() { return ("missing", false); }
        let Ok(mut stream) = helper() else { return ("unavailable", false); };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(2)));
        if stream.write_all(b"CAPABILITIES\n").is_err() { return ("unavailable", false); }
        let mut line = String::new();
        if std::io::BufReader::new(stream).take(128).read_line(&mut line).is_err() { return ("unavailable", false); }
        match line.trim() {
            "CAPABILITIES 3 kill-switch live-kill-switch" => ("ready", true),
            "CAPABILITIES 3" => ("ready", false),
            "CAPABILITIES 2" | "CAPABILITIES 2 kill-switch" => ("outdated", false),
            _ => ("unavailable", false),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    ("unavailable", false)
}
pub fn known_server(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') }
#[cfg(not(target_os = "windows"))]
fn unavailable() -> AppError { AppError::new("vpn_helper_unavailable", "The Stellar VPN system helper is unavailable.") }
#[cfg(target_os = "macos")]
fn helper() -> Result<std::os::unix::net::UnixStream, AppError> {
    use std::os::fd::AsRawFd;
    unsafe extern "C" { fn getpeereid(fd: i32, euid: *mut u32, egid: *mut u32) -> i32; }
    let stream = std::os::unix::net::UnixStream::connect("/var/run/stellar-vpn/helper.sock").map_err(|_| unavailable())?;
    let (mut uid, mut gid) = (u32::MAX, u32::MAX);
    if unsafe { getpeereid(stream.as_raw_fd(), &mut uid, &mut gid) } != 0 || uid != 0 { return Err(unavailable()); }
    stream.set_read_timeout(Some(std::time::Duration::from_secs(40))).map_err(|_| unavailable())?;
    stream.set_write_timeout(Some(std::time::Duration::from_secs(3))).map_err(|_| unavailable())?;
    Ok(stream)
}
#[cfg(target_os = "macos")]
fn response(stream: std::os::unix::net::UnixStream) -> Result<(ConnectionSnapshot, u64, u64), AppError> {
    use std::io::{BufRead, Read};
    let mut line = String::new();
    std::io::BufReader::new(stream).take(256).read_line(&mut line).map_err(|_| unavailable())?;
    let fields: Vec<_> = line.trim().split(' ').collect();
    if fields == ["ERROR", "timeout"] { return Err(AppError::new("vpn_timeout", "Connection timed out after 30 seconds. Please try again.")); }
    if fields == ["DISCONNECTED"] { return Ok((ConnectionSnapshot::default(), 0, 0)); }
    if fields == ["BLOCKED"] { return Ok((ConnectionSnapshot { traffic_blocked: true, ..ConnectionSnapshot::default() }, 0, 0)); }
    if fields.len() == 5 && fields[0] == "CONNECTED" && known_server(fields[1]) {
        let connected_at = fields[2].parse::<u64>().map_err(|_| unavailable())?;
        if let (Ok(received), Ok(sent)) = (fields[3].parse::<u64>(), fields[4].parse::<u64>()) {
            return Ok((ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(fields[1].into()), connected_at: Some(connected_at), ..ConnectionSnapshot::default() }, received, sent));
        }
    }
    Err(AppError::new("vpn_connection_failed", "Couldn’t establish the VPN connection. Please try again."))
}
pub fn disconnect_helper() -> Result<ConnectionSnapshot, AppError> {
    #[cfg(target_os = "windows")]
    { return super::windows_vpn::disconnect_helper(); }
    #[cfg(target_os = "macos")]
    { use std::io::Write; let mut stream = helper()?; stream.write_all(b"DISCONNECT\n").map_err(|_| unavailable())?; response(stream).map(|(snapshot, _, _)| snapshot) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err(unavailable())
}
pub fn interrupt_connect_helper() -> Result<ConnectionSnapshot, AppError> {
    #[cfg(target_os = "windows")]
    { return super::windows_vpn::interrupt_connect_helper(); }
    #[cfg(target_os = "macos")]
    { use std::io::Write; let mut stream = helper()?; stream.set_read_timeout(Some(std::time::Duration::from_secs(3))).map_err(|_| unavailable())?; stream.write_all(b"EXPIRE\n").map_err(|_| unavailable())?; response(stream).map(|(snapshot, _, _)| snapshot) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err(unavailable())
}
#[cfg(not(target_os = "windows"))]
impl VpnEngine for OpenVpnEngine {
    fn expire(&mut self) -> Result<ConnectionSnapshot, AppError> {
        if !self.kill_switch { return self.disconnect(); }
        #[cfg(target_os = "macos")]
        {
            use std::io::Write;
            let mut stream = helper()?; stream.write_all(b"EXPIRE\n").map_err(|_| unavailable())?;
            let (snapshot, _, _) = response(stream)?;
            self.connected = false; self.traffic = None;
            return Ok(snapshot);
        }
        #[cfg(not(target_os = "macos"))]
        Err(unavailable())
    }
    fn supports_kill_switch(&self) -> bool { self.firewall_supported || firewall_supported() }
    fn set_kill_switch(&mut self, enabled: bool) -> Result<(), AppError> {
        if enabled && !self.firewall_supported { self.firewall_supported = firewall_supported(); }
        if enabled && !self.firewall_supported { return Err(unavailable()); }
        if enabled == self.kill_switch { return Ok(()); }
        if self.connected || (!enabled && self.kill_switch) { live_protection(enabled)?; }
        self.kill_switch = enabled; Ok(())
    }
    fn supports_rotation(&self) -> bool { cfg!(target_os = "macos") }
    fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError> {
        self.connect_with_timeout(server_id, stellar_core::openvpn::CONNECTION_TIMEOUT)
    }
    fn connect_with_timeout(&mut self, server_id: &str, timeout: std::time::Duration) -> Result<ConnectionSnapshot, AppError> {
        if !known_server(server_id) { return Err(AppError::new("invalid_server", "Unknown VPN location.")); }
        let credentials = self.credentials.as_ref().ok_or_else(|| AppError::new("vpn_auth_required", "Please log in again to enable VPN."))?;
        let config = self.configurations.get(server_id).ok_or_else(|| AppError::new("vpn_config_required", "Open the app and select this location before connecting."))?;
        #[cfg(target_os = "macos")]
        { let mut stream = helper()?; credentials.write_helper_connect_budget(server_id, self.expires_at, config, self.kill_switch, timeout, &mut stream).map_err(|_| unavailable())?;
            let (snapshot, received, sent) = response(stream)?;
            if snapshot.status != ConnectionStatus::Connected || snapshot.server_id.as_deref() != Some(server_id) { return Err(unavailable()); }
            self.traffic = Some((std::time::Instant::now(), received, sent));
            self.connected = true; Ok(snapshot) }
        #[cfg(not(target_os = "macos"))]
        { let _ = (credentials, config, timeout); Err(unavailable()) }
    }
    fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> {
        let was_connected = self.connected; self.connected = false; self.traffic = None;
        match disconnect_helper() { Ok(value) => Ok(value), Err(error) if was_connected => Err(error), Err(_) => Ok(ConnectionSnapshot::default()) }
    }
    fn set_credentials(&mut self, credentials: VpnCredentials) -> Result<(), AppError> { self.credentials = Some(credentials); Ok(()) }
    fn clear_credentials(&mut self) { self.credentials = None; self.configurations.clear(); }
    fn set_session_expiry(&mut self, expires_at: u64) { self.expires_at = expires_at; }
    fn prepare(&mut self, server_id: &str, config: ValidatedConfig) -> Result<(), AppError> {
        if !known_server(server_id) { return Err(AppError::new("invalid_server", "Invalid VPN location.")); }
        if self.configurations.len() >= 64 && !self.configurations.contains_key(server_id) { self.configurations.clear(); }
        self.configurations.insert(server_id.into(), config); Ok(())
    }
    fn poll(&mut self) -> Result<Option<ConnectionSnapshot>, AppError> {
        if !self.connected && !self.kill_switch { return Ok(None); }
        #[cfg(target_os = "macos")]
        { use std::io::Write;
            let result = (|| { let mut stream = helper()?; stream.set_read_timeout(Some(std::time::Duration::from_secs(2))).map_err(|_| unavailable())?; stream.write_all(b"STATUS\n").map_err(|_| unavailable())?; response(stream) })();
            match result { Ok((mut snapshot, received, sent)) => {
                self.connected = snapshot.status == ConnectionStatus::Connected;
                if self.connected {
                    let now = std::time::Instant::now();
                    if let Some((last, previous_received, previous_sent)) = self.traffic {
                        let elapsed = now.duration_since(last).as_secs_f64();
                        snapshot.download_mbps = stellar_core::openvpn::traffic_mbps(previous_received, received, elapsed);
                        snapshot.upload_mbps = stellar_core::openvpn::traffic_mbps(previous_sent, sent, elapsed);
                    }
                    self.traffic = Some((now, received, sent));
                } else { self.traffic = None; }
                Ok(Some(snapshot))
            }, Err(_) => { self.connected = false; self.traffic = None; Ok(Some(ConnectionSnapshot::default())) } } }
        #[cfg(not(target_os = "macos"))]
        Ok(None)
    }
}
#[cfg(not(target_os = "windows"))]
fn live_protection(enabled: bool) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use std::io::{BufRead, Read, Write};
        let failure = || AppError::new("kill_switch_update_failed", "Could not update kill switch. Check that the latest Stellar VPN system helper is installed.");
        let mut stream = helper()?;
        stream.set_read_timeout(Some(std::time::Duration::from_secs(15))).map_err(|_| failure())?;
        writeln!(stream, "PROTECT {}", u8::from(enabled)).map_err(|_| failure())?;
        let mut line = String::new();
        std::io::BufReader::new(stream).take(64).read_line(&mut line).map_err(|_| failure())?;
        if line != format!("PROTECTED {}\n", u8::from(enabled)) { return Err(failure()); }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = enabled; Err(unavailable()) }
}
