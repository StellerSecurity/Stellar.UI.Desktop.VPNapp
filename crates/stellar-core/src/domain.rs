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
        Self { auto_connect: true, kill_switch: false, auto_rotate: false,
            notifications: true, menu_bar: true, language: "English".into() }
    }
}
impl Settings {
    pub fn validate(&self) -> Result<(), AppError> {
        if !["English", "Dansk", "Deutsch", "Türkçe", "Español", "Svenska", "Norsk (bokmål)", "Français", "Italiano", "Nederlands", "Polski", "Português (Brasil)"].contains(&self.language.as_str()) {
            return Err(AppError::new("invalid_settings", "Unsupported language"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Session { pub authenticated: bool, pub onboarding_complete: bool }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubscriptionAccess { pub active: bool, pub expires_at: Option<u64> }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionStatus { Connected, Disconnected }

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub traffic_blocked: bool,
    pub status: ConnectionStatus,
    pub server_id: Option<String>,
    pub connected_at: Option<u64>,
    pub download_mbps: Option<f64>,
    pub upload_mbps: Option<f64>,
}
impl Default for ConnectionSnapshot {
    fn default() -> Self { Self { traffic_blocked: false, status: ConnectionStatus::Disconnected, server_id: None, connected_at: None, download_mbps: None, upload_mbps: None } }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub subscription_access: Option<SubscriptionAccess>,
    pub capabilities: Capabilities,
    pub contract_version: u8,
    pub selected_server_id: String,
    pub runtime: &'static str,
    pub connection: ConnectionSnapshot,
    pub settings: Settings,
    pub session: Session,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities { pub auto_rotate: bool, pub kill_switch: bool }
#[derive(Debug, Serialize)]
pub struct AppError { pub code: &'static str, pub message: String }
impl AppError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self { Self { code, message: message.into() } }
}

#[cfg(test)]
mod language_tests {
    use super::*;
    #[test] fn all_supported_ui_languages_can_be_persisted() {
        for language in ["English", "Dansk", "Deutsch", "Türkçe", "Español", "Svenska", "Norsk (bokmål)", "Français", "Italiano", "Nederlands", "Polski", "Português (Brasil)"] {
            assert!(Settings { language: language.into(), ..Settings::default() }.validate().is_ok(), "{language}");
        }
        assert!(Settings { language: "unknown".into(), ..Settings::default() }.validate().is_err());
    }
}
