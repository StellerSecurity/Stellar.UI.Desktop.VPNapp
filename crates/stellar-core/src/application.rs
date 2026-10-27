use crate::domain::*;
use crate::ports::{PreferencesRepository, VpnEngine};

pub struct DesktopService {
    selected_server_id: String,
    settings: Settings,
    session: Session,
    connection: ConnectionSnapshot,
    preferences: Box<dyn PreferencesRepository>,
    engine: Box<dyn VpnEngine>,
    session_expires_at: Option<u64>,
}
impl DesktopService {
    pub fn new(preferences: Box<dyn PreferencesRepository>, engine: Box<dyn VpnEngine>) -> Result<Self, AppError> {
        let (settings, session) = preferences.load()?;
        settings.validate()?;
        Ok(Self { selected_server_id: "cz-1".into(), settings, session, connection: ConnectionSnapshot::default(), preferences, engine, session_expires_at: None })
    }
    pub fn accept_account_session(&mut self, expires_at: u64) -> Result<Session, AppError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        if expires_at <= now { return Err(AppError::new("invalid_session", "Your session has expired. Please log in again.")); }
        self.session_expires_at = Some(expires_at);
        self.session = Session { authenticated: true, onboarding_complete: false };
        Ok(self.session.clone())
    }
    pub fn expire_session(&mut self) -> Result<(), AppError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        if self.session_expires_at.is_some_and(|expiry| expiry <= now) { self.logout()?; }
        Ok(())
    }
    pub fn snapshot(&self) -> DesktopSnapshot {
        DesktopSnapshot { contract_version: 1, selected_server_id: self.selected_server_id.clone(), runtime: "native-preview", connection: self.connection.clone(),
            settings: self.settings.clone(), session: self.session.clone() }
    }
    pub fn select_server(&mut self, server_id: &str) -> Result<(), AppError> {
        if server_id.is_empty() || server_id.len() > 64 || !server_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-') {
            return Err(AppError::new("invalid_server", "Invalid server identity"));
        }
        self.selected_server_id = server_id.into();
        Ok(())
    }
    pub fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError> {
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Log in before connecting")); }
        self.connection = self.engine.connect(server_id)?;
        self.selected_server_id = server_id.into();
        Ok(self.connection.clone())
    }
    pub fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> {
        self.connection = self.engine.disconnect()?;
        Ok(self.connection.clone())
    }
    pub fn save_settings(&mut self, settings: Settings) -> Result<Settings, AppError> {
        settings.validate()?;
        self.preferences.save(&settings, &self.session)?;
        self.settings = settings;
        Ok(self.settings.clone())
    }
    pub fn create_preview_session(&mut self) -> Result<Session, AppError> {
        let next = Session { authenticated: true, onboarding_complete: false };
        self.preferences.save(&self.settings, &next)?;
        self.session = next;
        Ok(self.session.clone())
    }
    pub fn complete_onboarding(&mut self) -> Result<Session, AppError> {
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Log in before continuing")); }
        let next = Session { authenticated: true, onboarding_complete: true };
        self.preferences.save(&self.settings, &next)?;
        self.session = next;
        Ok(self.session.clone())
    }
    pub fn logout(&mut self) -> Result<Session, AppError> {
        self.disconnect()?;
        let next = Session::default();
        self.preferences.save(&self.settings, &next)?;
        self.session = next;
        self.session_expires_at = None;
        Ok(self.session.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct MemoryPreferences;
    impl PreferencesRepository for MemoryPreferences {
        fn load(&self) -> Result<(Settings, Session), AppError> { Ok((Settings::default(), Session::default())) }
        fn save(&self, _: &Settings, _: &Session) -> Result<(), AppError> { Ok(()) }
    }
    struct Engine;
    impl VpnEngine for Engine {
        fn connect(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> {
            Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(id.into()), connected_at: Some(1000) })
        }
        fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot::default()) }
    }
    #[test]
    fn unauthenticated_connections_are_rejected_and_logout_disconnects() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        assert!(service.connect("dk-1").is_err());
        service.create_preview_session().unwrap();
        assert_eq!(service.connect("dk-1").unwrap().status, ConnectionStatus::Connected);
        service.logout().unwrap();
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(!service.snapshot().session.authenticated);
    }
    #[test]
    fn real_session_expires_and_onboarding_does_not_extend_it() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        assert!(service.accept_account_session(0).is_err());
        service.accept_account_session(u64::MAX).unwrap();
        service.complete_onboarding().unwrap();
        assert_eq!(service.session_expires_at, Some(u64::MAX));
        service.session_expires_at = Some(0);
        assert!(service.connect("dk-1").is_err());
        assert!(!service.snapshot().session.authenticated);
        assert_eq!(service.session_expires_at, None);
    }
    #[test]
    fn selection_is_shared_and_survives_disconnect() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        service.select_server("dk-1").unwrap();
        assert_eq!(service.snapshot().selected_server_id, "dk-1");
        assert!(service.select_server("../bad").is_err());
        assert_eq!(service.snapshot().selected_server_id, "dk-1");
        service.create_preview_session().unwrap();
        service.connect("ch-1").unwrap();
        service.disconnect().unwrap();
        assert_eq!(service.snapshot().selected_server_id, "ch-1");
    }
    #[test]
    fn invalid_settings_do_not_replace_current_settings() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        let settings = Settings { language: "../../unexpected".into(), ..Settings::default() };
        assert!(service.save_settings(settings).is_err());
        assert_eq!(service.snapshot().settings, Settings::default());
    }
}
