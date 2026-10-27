use std::time::{SystemTime, UNIX_EPOCH};
use stellar_core::{domain::{AppError, ConnectionSnapshot, ConnectionStatus}, ports::VpnEngine};

/// Pure simulation. No tunnel, DNS, firewall, system proxy or privileged helper is modified.
pub struct PreviewVpnEngine;
pub fn known_server(server_id: &str) -> bool { SERVER_IDS.contains(&server_id) }
impl VpnEngine for PreviewVpnEngine {
    fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError> {
        if !SERVER_IDS.contains(&server_id) { return Err(AppError::new("invalid_server", "Unknown VPN server")); }
        let now = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| AppError::new("clock_error", "System clock is unavailable"))?.as_millis() as u64;
        Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(server_id.into()), connected_at: Some(now) })
    }
    fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot::default()) }
}
include!("server_ids.rs");
