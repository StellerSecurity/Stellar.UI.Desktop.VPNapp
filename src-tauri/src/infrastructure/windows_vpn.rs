use std::{collections::HashMap, time::{Duration, Instant}};
use stellar_core::{domain::{AppError, ConnectionSnapshot, ConnectionStatus}, ports::VpnEngine,
    openvpn::{VpnCredentials, ValidatedConfig, CONNECTION_TIMEOUT, traffic_mbps}, helper_protocol};
use super::windows;
fn failed() -> AppError { AppError::new("vpn_helper_unavailable", "The Stellar VPN system helper is unavailable.") }
fn command(value: &[u8]) -> Result<(ConnectionSnapshot, u64, u64), AppError> { helper_protocol::decode(&windows::exchange(value.to_vec(), 4000)?) }
pub fn installation_check() -> (&'static str, bool) {
    match windows::exchange(b"CAPABILITIES\n".to_vec(), 3000).ok().and_then(|r| helper_protocol::capabilities(&r)) {
        Some(verified) => ("ready", verified), None => ("unavailable", false),
    }
}
pub fn disconnect_helper() -> Result<ConnectionSnapshot, AppError> { command(b"DISCONNECT\n").map(|r| r.0) }
pub fn interrupt_connect_helper() -> Result<ConnectionSnapshot, AppError> { command(b"EXPIRE\n").map(|r| r.0) }
#[derive(Default)]
pub struct OpenVpnEngine {
    credentials: Option<VpnCredentials>, configurations: HashMap<String, ValidatedConfig>, expires_at: u64,
    kill_switch: bool, connected: bool, armed: bool, traffic: Option<(Instant, u64, u64)>,
}
impl VpnEngine for OpenVpnEngine {
    fn supports_kill_switch(&self) -> bool { installation_check().1 }
    fn supports_rotation(&self) -> bool { true }
    fn set_kill_switch(&mut self, enabled: bool) -> Result<(), AppError> {
        if enabled == self.kill_switch { return Ok(()); }
        if enabled && !self.supports_kill_switch() { return Err(failed()); }
        // A preference is not an active firewall. Arming while idle would block
        // the API calls needed to obtain the first VPN configuration.
        if self.connected || self.armed {
            let request = format!("PROTECT {}\n", u8::from(enabled)); let expected = format!("PROTECTED {}\n", u8::from(enabled));
            if windows::exchange(request.into_bytes(), 15000)? != expected.as_bytes() { return Err(failed()); }
            self.armed = enabled;
        }
        self.kill_switch = enabled; Ok(())
    }
    fn connect(&mut self, server: &str) -> Result<ConnectionSnapshot, AppError> { self.connect_with_timeout(server, CONNECTION_TIMEOUT) }
    fn connect_with_timeout(&mut self, server: &str, timeout: Duration) -> Result<ConnectionSnapshot, AppError> {
        let auth = self.credentials.as_ref().ok_or_else(|| AppError::new("vpn_auth_required", "Please log in again to enable VPN."))?;
        let config = self.configurations.get(server).ok_or_else(|| AppError::new("vpn_config_required", "Select this location before connecting."))?;
        let mut request = Vec::new();
        auth.write_helper_connect_budget(server, self.expires_at, config, self.kill_switch, timeout, &mut request).map_err(|_| failed())?;
        let response = windows::exchange(request, 40000);
        // Read back the helper state after any unsuccessful attempt. Never infer
        // that traffic is blocked merely because the setting is enabled.
        let (snapshot, received, sent) = match response.and_then(|r| helper_protocol::decode(&r)) {
            Ok(value) => value,
            Err(error) => { if let Ok((state, _, _)) = command(b"STATUS\n") { self.armed = state.traffic_blocked; self.connected = state.status == ConnectionStatus::Connected; } return Err(error); }
        };
        if snapshot.status != ConnectionStatus::Connected || snapshot.server_id.as_deref() != Some(server) { return Err(failed()); }
        self.connected = true; self.armed = self.kill_switch; self.traffic = Some((Instant::now(), received, sent)); Ok(snapshot)
    }
    fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> {
        let snapshot = match disconnect_helper() { Ok(value) => value, Err(_) if !self.connected && !self.armed => ConnectionSnapshot::default(), Err(error) => return Err(error) };
        self.connected = false; self.armed = false; self.traffic = None; Ok(snapshot)
    }
    fn expire(&mut self) -> Result<ConnectionSnapshot, AppError> {
        let snapshot = if self.kill_switch { interrupt_connect_helper()? } else { disconnect_helper()? };
        self.connected = false; self.armed = snapshot.traffic_blocked; self.traffic = None; Ok(snapshot)
    }
    fn set_credentials(&mut self, credentials: VpnCredentials) -> Result<(), AppError> { self.credentials = Some(credentials); Ok(()) }
    fn clear_credentials(&mut self) { self.credentials = None; self.configurations.clear(); }
    fn set_session_expiry(&mut self, expires_at: u64) { self.expires_at = expires_at; }
    fn prepare(&mut self, server: &str, config: ValidatedConfig) -> Result<(), AppError> {
        if !super::vpn::known_server(server) { return Err(failed()); }
        if self.configurations.len() >= 64 && !self.configurations.contains_key(server) { self.configurations.clear(); }
        self.configurations.insert(server.into(), config); Ok(())
    }
    fn poll(&mut self) -> Result<Option<ConnectionSnapshot>, AppError> {
        if !self.connected && !self.armed { return Ok(None); }
        match command(b"STATUS\n") {
            Ok((mut snapshot, received, sent)) => {
                self.connected = snapshot.status == ConnectionStatus::Connected;
                self.armed = snapshot.traffic_blocked || (self.connected && self.kill_switch);
                if self.connected {
                    if let Some((at, previous_received, previous_sent)) = self.traffic {
                        snapshot.download_mbps = traffic_mbps(previous_received, received, at.elapsed().as_secs_f64());
                        snapshot.upload_mbps = traffic_mbps(previous_sent, sent, at.elapsed().as_secs_f64());
                    }
                    self.traffic = Some((Instant::now(), received, sent));
                } else { self.traffic = None; }
                Ok(Some(snapshot))
            }
            Err(_) => { self.connected = false; self.traffic = None;
                // Refresh must replace a previous green Connected snapshot even
                // when the broker cannot answer. Keep internal protection intent
                // for recovery, but do not assert an unverified blocking state.
                Ok(Some(ConnectionSnapshot::default())) }
        }
    }
}
