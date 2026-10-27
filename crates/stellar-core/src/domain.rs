use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub auto_connect: bool,
    pub kill_switch: bool,
    pub auto_rotate: bool,
    pub notifications: bool,
    pub menu_bar: bool,
    pub language: String,
}
impl Default for Settings {
    fn default() -> Self {
        Self { auto_connect: false, kill_switch: true, auto_rotate: false,
            notifications: true, menu_bar: true, language: "English".into() }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), AppError> {
        if !["English", "Dansk", "Deutsch", "Français", "Español", "Svenska"].contains(&self.language.as_str()) {
            return Err(AppError::new("invalid_settings", "Unsupported language"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session { pub authenticated: bool, pub onboarding_complete: bool }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus { Connected, Disconnected }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub status: ConnectionStatus,
    pub server_id: Option<String>,
    pub connected_at: Option<u64>,
}
impl Default for ConnectionSnapshot {
    fn default() -> Self { Self { status: ConnectionStatus::Disconnected, server_id: None, connected_at: None } }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub contract_version: u8,
    pub selected_server_id: String,
    pub runtime: &'static str,
    pub connection: ConnectionSnapshot,
    pub settings: Settings,
    pub session: Session,
}
#[derive(Debug, Serialize)]
pub struct AppError { pub code: &'static str, pub message: String }
impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self { Self { code, message: message.into() } }
}
