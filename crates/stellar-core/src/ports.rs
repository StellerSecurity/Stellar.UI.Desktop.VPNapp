use crate::domain::{AppError, ConnectionSnapshot, Session, Settings};

/// Native VPN implementations will live behind this boundary. The desktop shell stays unprivileged.
pub trait VpnEngine: Send {
    fn supports_rotation(&self) -> bool { false }
    fn supports_kill_switch(&self) -> bool { false }
    fn set_kill_switch(&mut self, enabled: bool) -> Result<(), AppError> {
        if enabled { Err(AppError::new("feature_unavailable", "Kill switch is unavailable.")) } else { Ok(()) }
    }
    fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError>;
    fn connect_with_timeout(&mut self, server_id: &str, _timeout: std::time::Duration) -> Result<ConnectionSnapshot, AppError> { self.connect(server_id) }
    fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError>;
    /// Automatic expiry is not user consent to remove a firewall block.
    fn expire(&mut self) -> Result<ConnectionSnapshot, AppError> { self.disconnect() }
    fn set_credentials(&mut self, _credentials: crate::openvpn::VpnCredentials) -> Result<(), AppError> { Err(AppError::new("vpn_unavailable", "VPN authentication is unavailable.")) }
    fn clear_credentials(&mut self) {}
    fn set_session_expiry(&mut self, _expires_at: u64) {}
    fn prepare(&mut self, _server_id: &str, _config: crate::openvpn::ValidatedConfig) -> Result<(), AppError> { Err(AppError::new("vpn_unavailable", "VPN configuration is unavailable.")) }
    fn poll(&mut self) -> Result<Option<ConnectionSnapshot>, AppError> { Ok(None) }
}
/// Stores non-secret preferences only. Tokens need a separate OS credential-vault adapter.
pub trait PreferencesRepository: Send {
    fn load_selected_server(&self) -> Result<Option<String>, AppError> { Ok(None) }
    fn save_selected_server(&self, _server_id: &str) -> Result<(), AppError> { Ok(()) }
    fn load(&self) -> Result<(Settings, Session), AppError>;
    fn save(&self, settings: &Settings, session: &Session) -> Result<(), AppError>;
}
