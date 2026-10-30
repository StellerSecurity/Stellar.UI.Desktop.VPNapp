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
    subscription_access: Option<SubscriptionAccess>,
    subscription_stopped: bool,
    subscription_deadline: Option<std::time::Instant>,
    rotation: crate::rotation::RotationSchedule,
    rotation_target: Option<String>,
    recovery: crate::recovery::Recovery,
}
impl DesktopService {
    pub fn new(preferences: Box<dyn PreferencesRepository>, mut engine: Box<dyn VpnEngine>) -> Result<Self, AppError> {
        let (mut settings, session) = preferences.load()?;
        settings.auto_rotate &= engine.supports_rotation();
        // Do not claim traffic is blocked until a platform firewall exists.
        settings.kill_switch &= engine.supports_kill_switch();
        engine.set_kill_switch(settings.kill_switch)?;
        settings.validate()?;
        let selected_server_id = preferences.load_selected_server()?.unwrap_or_else(|| "cz-1".into());
        if !valid_server_id(&selected_server_id) { return Err(AppError::new("invalid_server", "Invalid saved location")); }
        Ok(Self { selected_server_id, settings, session, connection: ConnectionSnapshot::default(), preferences, engine, session_expires_at: None, subscription_access: None, subscription_stopped: false, subscription_deadline: None, rotation: Default::default(), rotation_target: None, recovery: Default::default() })
    }
    pub fn accept_account_session(&mut self, expires_at: u64) -> Result<Session, AppError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        if expires_at <= now { return Err(AppError::new("invalid_session", "Your session has expired. Please log in again.")); }
        self.disconnect()?;
        self.engine.clear_credentials();
        self.rotation_target = None;
        self.engine.set_session_expiry(expires_at);
        self.session_expires_at = Some(expires_at);
        self.subscription_access = None;
        self.subscription_stopped = false;
        self.subscription_deadline = None;
        self.session = Session { authenticated: true, onboarding_complete: false };
        Ok(self.session.clone())
    }
    pub fn accept_vpn_credentials(&mut self, credentials: crate::openvpn::VpnCredentials) -> Result<(), AppError> {
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Please log in.")); }
        self.engine.set_credentials(credentials)
    }
    pub fn prepare_vpn_server(&mut self, server_id: &str, config: crate::openvpn::ValidatedConfig) -> Result<(), AppError> {
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Please log in.")); }
        self.engine.prepare(server_id, config)
    }
    pub fn refresh_connection(&mut self) -> Result<(), AppError> {
        self.enforce_subscription(Self::now())?;
        if self.session.authenticated { if let Some(connection) = self.engine.poll()? {
            if self.connection.status == ConnectionStatus::Connected && connection.status != ConnectionStatus::Connected { self.recovery.lost(std::time::Instant::now()); }
            if connection.status != ConnectionStatus::Connected { self.rotation.reset(false, false, std::time::Instant::now()); }
            self.connection = connection;
        } }
        Ok(())
    }
    pub fn recover_after_resume(&mut self) -> Result<(), AppError> {
        self.enforce_subscription(Self::now())?;
        if !self.session.authenticated || self.connection.status != ConnectionStatus::Connected { return Ok(()); }
        // Stop the stale transport, not the connection intent. expire() retains
        // a protected engine's firewall; credentials/config stay native.
        self.connection = self.engine.expire()?;
        self.recovery.lost(std::time::Instant::now());
        self.rotation.reset(false, false, std::time::Instant::now());
        Ok(())
    }
    pub fn prepare_rotation(&mut self, server_id: &str, config: crate::openvpn::ValidatedConfig) -> Result<(), AppError> {
        if !self.settings.auto_rotate || !self.engine.supports_rotation() { return Err(AppError::new("feature_unavailable", "Auto Rotate is unavailable.")); }
        if self.connection.server_id.as_deref() == Some(server_id) { return Ok(()); }
        self.prepare_vpn_server(server_id, config)?;
        self.rotation_target = Some(server_id.into());
        Ok(())
    }
    pub fn due_rotation(&mut self, now: std::time::Instant) -> Option<String> {
        if self.require_subscription().is_err() { return None; }
        if !self.settings.auto_rotate || !self.session.authenticated || self.connection.status != ConnectionStatus::Connected || !self.rotation.due(now) { return None; }
        // One attempt per interval, even when preparation failed or the machine slept.
        self.rotation.reset(true, true, now);
        self.rotation_target.take().filter(|target| self.connection.server_id.as_ref() != Some(target))
    }
    pub fn due_recovery(&mut self, now: std::time::Instant) -> Option<crate::recovery::RecoveryAttempt> {
        if self.require_subscription().is_err() { return None; }
        if !self.session.authenticated || self.connection.status == ConnectionStatus::Connected { return None; }
        self.recovery.take_due(now)
    }
    pub fn recover_connection(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> {
        self.expire_session()?;
        self.enforce_subscription(Self::now())?; self.require_subscription()?;
        if !self.session.authenticated || !self.recovery.owns(id) || self.connection.status == ConnectionStatus::Connected {
            return Err(AppError::new("recovery_cancelled", "Automatic reconnection was cancelled."));
        }
        // Reuse the already validated native config and VPN credentials. Do not
        // fetch an API through a blocked network, revoke auth or disarm PF.
        match self.engine.connect_with_timeout(id, crate::openvpn::CONNECTION_TIMEOUT) {
            Ok(connection) => {
                self.connection = connection;
                self.enforce_subscription(Self::now())?; self.require_subscription()?;
                if self.connection.status == ConnectionStatus::Connected {
                    self.recovery.established(id);
                    self.rotation.reset(self.settings.auto_rotate, true, std::time::Instant::now());
                } else { self.recovery.failed(std::time::Instant::now()); }
                Ok(self.connection.clone())
            }
            Err(error) => {
                if let Some(connection) = self.engine.poll().ok().flatten() { self.connection = connection; }
                self.recovery.failed(std::time::Instant::now());
                Err(error)
            }
        }
    }
    pub fn expire_session(&mut self) -> Result<(), AppError> {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
        if self.session_expires_at.is_some_and(|expiry| expiry <= now) {
            self.recovery.cancel();
            self.connection = self.engine.expire()?;
            self.rotation.reset(false, false, std::time::Instant::now());
            self.rotation_target = None;
            self.engine.clear_credentials();
            self.session = Session::default();
            self.session_expires_at = None;
            self.preferences.save(&self.settings, &self.session)?;
        }
        Ok(())
    }
    pub fn snapshot(&self) -> DesktopSnapshot {
        DesktopSnapshot { subscription_access: self.subscription_access.clone(), capabilities: Capabilities { auto_rotate: self.engine.supports_rotation(), kill_switch: self.engine.supports_kill_switch() }, contract_version: 1, selected_server_id: self.selected_server_id.clone(), runtime: "native-preview", connection: self.connection.clone(),
            settings: self.settings.clone(), session: self.session.clone() }
    }
    pub fn select_server(&mut self, server_id: &str) -> Result<(), AppError> {
        if !valid_server_id(server_id) {
            return Err(AppError::new("invalid_server", "Invalid server identity"));
        }
        self.preferences.save_selected_server(server_id)?;
        self.selected_server_id = server_id.into();
        Ok(())
    }
    pub fn connect(&mut self, server_id: &str) -> Result<ConnectionSnapshot, AppError> {
        self.connect_with_timeout(server_id, crate::openvpn::CONNECTION_TIMEOUT)
    }
    pub fn connect_with_timeout(&mut self, server_id: &str, timeout: std::time::Duration) -> Result<ConnectionSnapshot, AppError> {
        if timeout.is_zero() || timeout > crate::openvpn::CONNECTION_TIMEOUT { return Err(AppError::new("vpn_timeout", "Connection timed out after 30 seconds. Please try again.")); }
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Log in before connecting")); }
        self.enforce_subscription(Self::now())?; self.require_subscription()?;
        self.select_server(server_id)?;
        self.recovery.cancel();
        let previous = self.connection.server_id.clone();
        self.rotation.reset(false, false, std::time::Instant::now());
        self.connection = match self.engine.connect_with_timeout(server_id, timeout) {
            Ok(connection) => connection,
            Err(error) => { self.connection = self.engine.poll().ok().flatten().unwrap_or_default(); return Err(error); }
        };
        self.enforce_subscription(Self::now())?; self.require_subscription()?;
        self.selected_server_id = server_id.into();
        if self.connection.status == ConnectionStatus::Connected { self.recovery.established(server_id); }
        // The previous config stays native, allowing background rotation back
        // even if a suspended webview cannot prepare a new candidate immediately.
        if previous.as_deref() != Some(server_id) { self.rotation_target = previous.or_else(|| self.rotation_target.take()); }
        self.rotation.reset(self.settings.auto_rotate, self.connection.status == ConnectionStatus::Connected, std::time::Instant::now());
        Ok(self.connection.clone())
    }
    pub fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> {
        self.recovery.cancel();
        self.rotation.reset(false, false, std::time::Instant::now());
        self.connection = self.engine.disconnect()?;
        Ok(self.connection.clone())
    }
    pub fn cancel_connection(&mut self) -> Result<ConnectionSnapshot, AppError> {
        self.recovery.cancel();
        self.rotation.reset(false, false, std::time::Instant::now());
        self.rotation_target = None;
        // Unlike explicit Unblock/Disconnect, cancellation retains an armed kill switch.
        self.connection = self.engine.expire()?;
        Ok(self.connection.clone())
    }
    fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }
    pub fn update_subscription_access(&mut self, access: SubscriptionAccess) -> Result<(), AppError> {
        self.expire_session()?;
        if !self.session.authenticated { return Err(AppError::new("unauthenticated", "Please log in.")); }
        let expiry = self.session_expires_at.unwrap_or(u64::MAX).min(access.expires_at.unwrap_or(u64::MAX));
        self.engine.set_session_expiry(expiry);
        self.subscription_stopped = false;
        self.subscription_deadline = access.expires_at.and_then(|expiry| std::time::Instant::now().checked_add(std::time::Duration::from_secs(expiry.saturating_sub(Self::now()))));
        self.subscription_access = Some(access);
        self.enforce_subscription(Self::now())
    }
    fn require_subscription(&self) -> Result<(), AppError> {
        match &self.subscription_access {
            Some(access) if access.active && !access.expires_at.is_some_and(|expiry| expiry <= Self::now()) && !self.subscription_deadline.is_some_and(|deadline| deadline <= std::time::Instant::now()) => Ok(()),
            Some(_) => Err(AppError::new("subscription_required", "An active VPN subscription is required.")),
            None => Err(AppError::new("subscription_unverified", "Could not verify your subscription. Please try again.")),
        }
    }
    fn enforce_subscription(&mut self, now: u64) -> Result<(), AppError> {
        let Some(access) = &mut self.subscription_access else { return Ok(()); };
        if access.expires_at.is_some_and(|expiry| expiry <= now) || self.subscription_deadline.is_some_and(|deadline| deadline <= std::time::Instant::now()) { access.active = false; }
        if access.active || self.subscription_stopped { return Ok(()); }
        self.recovery.cancel(); self.rotation.reset(false, false, std::time::Instant::now()); self.rotation_target = None;
        // Expiry is never consent to remove an armed kill switch.
        self.connection = self.engine.expire()?;
        self.subscription_stopped = true;
        Ok(())
    }
    pub fn save_settings(&mut self, settings: Settings) -> Result<Settings, AppError> {
        if settings.kill_switch && !self.engine.supports_kill_switch() { return Err(AppError::new("feature_unavailable", "Kill switch requires a verified platform firewall.")); }
        if settings.auto_rotate && !self.engine.supports_rotation() { return Err(AppError::new("feature_unavailable", "Auto Rotate is unavailable on this platform.")); }
        settings.validate()?;
        if settings.kill_switch != self.settings.kill_switch { self.engine.set_kill_switch(settings.kill_switch)?; }
        self.preferences.save(&settings, &self.session)?;
        if self.settings.auto_rotate != settings.auto_rotate {
            self.rotation.reset(settings.auto_rotate, self.connection.status == ConnectionStatus::Connected, std::time::Instant::now());
            if !settings.auto_rotate { self.rotation_target = None; }
        }
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
        self.engine.clear_credentials();
        self.rotation_target = None;
        let next = Session::default();
        self.preferences.save(&self.settings, &next)?;
        self.session = next;
        self.session_expires_at = None;
        self.subscription_access = None; self.subscription_stopped = false; self.subscription_deadline = None;
        Ok(self.session.clone())
    }
}

fn valid_server_id(id: &str) -> bool { !id.is_empty() && id.len() <= 64 && id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') }

#[cfg(test)]
mod tests {
    use super::*;
    fn grant(service: &mut DesktopService) { service.update_subscription_access(SubscriptionAccess { active: true, expires_at: None }).unwrap(); }
    #[test] fn subscription_access_is_required_and_account_login_is_not_a_subscription() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        service.accept_account_session(u64::MAX).unwrap();
        assert_eq!(service.connect("dk-1").unwrap_err().code, "subscription_unverified");
        service.update_subscription_access(SubscriptionAccess { active: false, expires_at: None }).unwrap();
        assert_eq!(service.connect("dk-1").unwrap_err().code, "subscription_required");
        assert!(service.snapshot().session.authenticated);
        grant(&mut service); service.connect("dk-1").unwrap();
    }
    #[test] fn native_subscription_expiry_stops_tunnel_recovery_and_rotation_without_unblocking() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(ProtectedEngine)).unwrap();
        service.accept_account_session(u64::MAX).unwrap();
        service.save_settings(Settings { kill_switch: true, ..Settings::default() }).unwrap();
        let expiry = DesktopService::now() + 100;
        service.update_subscription_access(SubscriptionAccess { active: true, expires_at: Some(expiry) }).unwrap();
        service.connect("dk-1").unwrap();
        service.enforce_subscription(expiry).unwrap();
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(service.snapshot().connection.traffic_blocked);
        assert!(service.snapshot().session.authenticated);
        assert!(!service.snapshot().subscription_access.unwrap().active);
        assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(999)).is_none());
        assert!(service.recover_connection("dk-1").is_err());
        assert!(service.connect("dk-1").is_err());
    }
    #[test] fn inactive_status_stops_an_active_tunnel_and_renewal_does_not_auto_reconnect() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service); service.connect("dk-1").unwrap();
        service.update_subscription_access(SubscriptionAccess { active: false, expires_at: None }).unwrap();
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        grant(&mut service);
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(999)).is_none());
        service.connect("dk-1").unwrap();
    }
    #[test] fn a_backward_wall_clock_change_cannot_extend_an_already_granted_deadline() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        service.accept_account_session(u64::MAX).unwrap();
        service.update_subscription_access(SubscriptionAccess { active: true, expires_at: Some(DesktopService::now() + 1000) }).unwrap();
        service.connect("dk-1").unwrap();
        service.subscription_deadline = Some(std::time::Instant::now());
        service.enforce_subscription(1).unwrap();
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(!service.snapshot().subscription_access.unwrap().active);
    }
    #[derive(Default)]
    struct RecoveryTestState { connected: bool, blocked: bool, fail: bool, disconnects: u32 }
    struct RecoveryEngine(std::sync::Arc<std::sync::Mutex<RecoveryTestState>>);
    impl VpnEngine for RecoveryEngine {
        fn connect(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> {
            let mut state = self.0.lock().unwrap();
            if state.fail { return Err(AppError::new("vpn_timeout", "Timed out")); }
            state.connected = true; state.blocked = false;
            Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(id.into()), ..Default::default() })
        }
        fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> {
            let mut state = self.0.lock().unwrap(); state.disconnects += 1; state.connected = false; state.blocked = false; Ok(Default::default())
        }
        fn poll(&mut self) -> Result<Option<ConnectionSnapshot>, AppError> {
            let state = self.0.lock().unwrap();
            Ok(Some(ConnectionSnapshot { traffic_blocked: state.blocked, status: if state.connected { ConnectionStatus::Connected } else { ConnectionStatus::Disconnected }, server_id: state.connected.then(|| "dk-1".into()), ..Default::default() }))
        }
        fn expire(&mut self) -> Result<ConnectionSnapshot, AppError> {
            let mut state = self.0.lock().unwrap(); state.connected = false; state.blocked = true;
            Ok(ConnectionSnapshot { traffic_blocked: true, ..Default::default() })
        }
    }
    #[test] fn unexpected_loss_recovers_without_disarming_a_firewall_or_fetching_an_api() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(RecoveryTestState::default()));
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RecoveryEngine(state.clone()))).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service); service.connect("dk-1").unwrap();
        let disconnects = state.lock().unwrap().disconnects;
        { let mut state = state.lock().unwrap(); state.connected = false; state.blocked = true; state.fail = true; }
        service.refresh_connection().unwrap();
        assert!(service.snapshot().connection.traffic_blocked);
        let attempt = service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(3)).unwrap();
        assert!(attempt.first); assert_eq!(attempt.server_id, "dk-1");
        assert!(service.recover_connection(&attempt.server_id).is_err());
        assert!(service.snapshot().connection.traffic_blocked);
        assert_eq!(state.lock().unwrap().disconnects, disconnects);
        assert!(service.due_recovery(std::time::Instant::now()).is_none());
        state.lock().unwrap().fail = false;
        let attempt = service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(6)).unwrap();
        assert!(!attempt.first);
        assert_eq!(service.recover_connection(&attempt.server_id).unwrap().status, ConnectionStatus::Connected);
        assert!(!service.snapshot().connection.traffic_blocked);
        assert_eq!(state.lock().unwrap().disconnects, disconnects);
        assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(999)).is_none());
    }
    #[test] fn resume_replaces_a_stale_connected_tunnel_without_unblocking_or_losing_intent() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(RecoveryTestState::default()));
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RecoveryEngine(state.clone()))).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service); service.connect("dk-1").unwrap();
        let disconnects = state.lock().unwrap().disconnects;
        service.recover_after_resume().unwrap();
        assert!(service.snapshot().connection.traffic_blocked);
        assert_eq!(state.lock().unwrap().disconnects, disconnects);
        let attempt = service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(3)).unwrap();
        assert_eq!(attempt.server_id, "dk-1");
        assert_eq!(service.recover_connection(&attempt.server_id).unwrap().status, ConnectionStatus::Connected);
        service.disconnect().unwrap();
        service.recover_after_resume().unwrap();
        assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(99)).is_none());
    }
    #[test] fn manual_unblock_and_session_expiry_cancel_automatic_reconnection() {
        for expire in [false, true] {
            let state = std::sync::Arc::new(std::sync::Mutex::new(RecoveryTestState::default()));
            let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RecoveryEngine(state.clone()))).unwrap();
            service.accept_account_session(u64::MAX).unwrap(); grant(&mut service); service.connect("dk-1").unwrap();
            { let mut state = state.lock().unwrap(); state.connected = false; state.blocked = true; }
            service.refresh_connection().unwrap();
            if expire { service.session_expires_at = Some(0); service.expire_session().unwrap(); }
            else { service.disconnect().unwrap(); }
            assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(999)).is_none());
            assert!(service.recover_connection("dk-1").is_err());
            assert_eq!(service.snapshot().connection.traffic_blocked, expire);
        }
    }
    #[test] fn manual_cancel_preserves_the_firewall_and_stops_recovery() {
        let state = std::sync::Arc::new(std::sync::Mutex::new(RecoveryTestState::default()));
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RecoveryEngine(state.clone()))).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service); service.connect("dk-1").unwrap();
        { let mut state = state.lock().unwrap(); state.connected = false; state.blocked = true; }
        service.refresh_connection().unwrap();
        let disconnects = state.lock().unwrap().disconnects;
        let cancelled = service.cancel_connection().unwrap();
        assert_eq!(cancelled.status, ConnectionStatus::Disconnected);
        assert!(cancelled.traffic_blocked);
        assert_eq!(state.lock().unwrap().disconnects, disconnects);
        assert!(service.due_recovery(std::time::Instant::now() + std::time::Duration::from_secs(999)).is_none());
        assert!(service.recover_connection("dk-1").is_err());
    }
    struct ProtectedEngine;
    impl VpnEngine for ProtectedEngine {
        fn supports_kill_switch(&self) -> bool { true }
        fn set_kill_switch(&mut self, _: bool) -> Result<(), AppError> { Ok(()) }
        fn connect(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(id.into()), ..Default::default() }) }
        fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(Default::default()) }
        fn expire(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot { traffic_blocked: true, ..Default::default() }) }
    }
    #[test] fn automatic_expiry_keeps_blocking_until_explicit_disconnect() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(ProtectedEngine)).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service);
        service.save_settings(Settings { kill_switch: true, ..Settings::default() }).unwrap();
        service.connect("dk-1").unwrap(); service.session_expires_at = Some(0);
        service.expire_session().unwrap();
        assert!(!service.snapshot().session.authenticated);
        assert!(service.snapshot().connection.traffic_blocked);
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        service.disconnect().unwrap();
        assert!(!service.snapshot().connection.traffic_blocked);
    }
    struct RotatingEngine { fail: bool }
    impl VpnEngine for RotatingEngine {
        fn supports_rotation(&self) -> bool { true }
        fn connect(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> {
            if self.fail { return Err(AppError::new("vpn_timeout", "Timed out")); }
            Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(id.into()), ..ConnectionSnapshot::default() })
        }
        fn prepare(&mut self, _: &str, _: crate::openvpn::ValidatedConfig) -> Result<(), AppError> { Ok(()) }
        fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot::default()) }
    }
    fn rotation_config() -> crate::openvpn::ValidatedConfig {
        crate::openvpn::ValidatedConfig::parse("client\ndev tun\nproto udp\nremote 203.0.113.10 1197\nremote-cert-tls server\nauth-user-pass\n<ca>\nABC=\n</ca>\n<cert>\nABC=\n</cert>\n<key>\nABC=\n</key>\n").unwrap()
    }
    #[test] fn rotation_requires_a_prepared_distinct_target_and_stops_after_disconnect() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RotatingEngine { fail: false })).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service);
        service.save_settings(Settings { auto_rotate: true, ..Settings::default() }).unwrap();
        service.connect("de-1").unwrap();
        service.prepare_rotation("ch-1", rotation_config()).unwrap();
        assert!(service.due_rotation(std::time::Instant::now()).is_none());
        assert_eq!(service.due_rotation(std::time::Instant::now() + crate::rotation::ROTATION_INTERVAL), Some("ch-1".into()));
        service.connect("ch-1").unwrap();
        assert_eq!(service.due_rotation(std::time::Instant::now() + crate::rotation::ROTATION_INTERVAL), Some("de-1".into()));
        service.disconnect().unwrap();
        assert!(service.due_rotation(std::time::Instant::now() + crate::rotation::ROTATION_INTERVAL * 10).is_none());
    }
    #[test] fn failed_connect_does_not_leave_false_connected_state() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(RotatingEngine { fail: true })).unwrap();
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service);
        assert_eq!(service.connect("de-1").unwrap_err().code, "vpn_timeout");
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(service.due_rotation(std::time::Instant::now() + crate::rotation::ROTATION_INTERVAL * 10).is_none());
    }
    #[test] fn unsupported_firewall_cannot_be_enabled_by_settings() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        assert!(!service.snapshot().capabilities.kill_switch);
        assert!(service.save_settings(Settings { kill_switch: true, ..Settings::default() }).is_err());
        assert!(!service.snapshot().settings.kill_switch);
    }
    struct LegacyRotatePreferences;
    impl PreferencesRepository for LegacyRotatePreferences {
        fn load(&self) -> Result<(Settings, Session), AppError> { Ok((Settings { auto_rotate: true, ..Settings::default() }, Session::default())) }
        fn save(&self, _: &Settings, _: &Session) -> Result<(), AppError> { Ok(()) }
    }
    #[test]
    fn unimplemented_rotation_cannot_be_enabled_by_legacy_preferences_or_ipc() {
        let mut service = DesktopService::new(Box::new(LegacyRotatePreferences), Box::new(Engine)).unwrap();
        assert!(!service.snapshot().settings.auto_rotate);
        let result = service.save_settings(Settings { auto_rotate: true, ..Settings::default() });
        assert_eq!(result.unwrap_err().code, "feature_unavailable");
        assert!(!service.snapshot().settings.auto_rotate);
    }
    struct MemoryPreferences;
    impl PreferencesRepository for MemoryPreferences {
        fn load(&self) -> Result<(Settings, Session), AppError> { Ok((Settings::default(), Session::default())) }
        fn save(&self, _: &Settings, _: &Session) -> Result<(), AppError> { Ok(()) }
    }
    struct Engine;
    impl VpnEngine for Engine {
        fn connect(&mut self, id: &str) -> Result<ConnectionSnapshot, AppError> {
            Ok(ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(id.into()), connected_at: Some(1000), ..ConnectionSnapshot::default() })
        }
        fn disconnect(&mut self) -> Result<ConnectionSnapshot, AppError> { Ok(ConnectionSnapshot::default()) }
    }
    #[test]
    fn unauthenticated_connections_are_rejected_and_logout_disconnects() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        assert!(service.connect("dk-1").is_err());
        service.create_preview_session().unwrap();
        grant(&mut service);
        assert_eq!(service.connect("dk-1").unwrap().status, ConnectionStatus::Connected);
        service.logout().unwrap();
        assert_eq!(service.snapshot().connection.status, ConnectionStatus::Disconnected);
        assert!(!service.snapshot().session.authenticated);
    }
    #[test]
    fn real_session_expires_and_onboarding_does_not_extend_it() {
        let mut service = DesktopService::new(Box::new(MemoryPreferences), Box::new(Engine)).unwrap();
        assert!(service.accept_account_session(0).is_err());
        service.accept_account_session(u64::MAX).unwrap(); grant(&mut service);
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
        grant(&mut service);
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
