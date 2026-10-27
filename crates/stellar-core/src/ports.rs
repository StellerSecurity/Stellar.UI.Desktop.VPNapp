use crate::domain::{AppError, ConnectionSnapshot, Session, Settings};

/// Native VPN implementations will live behind this boundary. The desktop shell stays unprivileged.
pub trait VpnEngine: Send {
    fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError>;
    fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError>;
}
/// Stores non-secret preferences only. Tokens need a separate OS credential-vault adapter.
pub trait PreferencesRepository: Send {
    fn load(&self) -> Result<(Settings, Session), AppError>;
    fn save(&self, settings: &Settings, session: &Session) -> Result<(), AppError>;
}
