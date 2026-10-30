use std::sync::MutexGuard;
use stellar_core::{application::DesktopService, domain::*};
use tauri::{State, AppHandle, Emitter, Manager};
use crate::AppState;
use stellar_core::notifications::Notice;

fn notice(app: &AppHandle, event: Notice) {
    if let Some(notifications) = app.try_state::<crate::notifications::Notifications>() {
        notifications.transition(app, event);
    }
}

fn service<'a>(state: &'a State<'_, AppState>) -> Result<MutexGuard<'a, DesktopService>, AppError> {
    state.0.lock().map_err(|_| AppError::new("state_unavailable", "Desktop state is unavailable"))
}
fn mutate<T>(app: &AppHandle, state: &State<'_, AppState>, action: impl FnOnce(&mut DesktopService) -> Result<T, AppError>) -> Result<T, AppError> {
    let mut service = service(state)?;
    let before = service.snapshot();
    // Failure can clear a stale connection too; publish that snapshot rather
    // than returning early and leaving a false Connected state in the UI.
    let result = action(&mut service);
    let snapshot = service.snapshot();
    drop(service);
    if let Some(notifications) = app.try_state::<crate::notifications::Notifications>() {
        notifications.enabled(snapshot.settings.notifications);
        notifications.language(&snapshot.settings.language);
        if !notifications.is_cancelling() { notifications.observe(app, &before.connection, &snapshot.connection); }
    }
    let _ = app.emit("desktop-changed", snapshot);
    crate::tray::refresh(app);
    result
}
async fn background<T: Send + 'static>(app: AppHandle, action: impl FnOnce(&mut DesktopService) -> Result<T, AppError> + Send + 'static) -> Result<T, AppError> {
    tauri::async_runtime::spawn_blocking(move || { let state = app.state::<AppState>(); mutate(&app, &state, action) }).await.map_err(|_| AppError::new("desktop_unavailable", "Stellar VPN is unavailable."))?
}
#[tauri::command]
pub async fn bootstrap(app: AppHandle) -> Result<DesktopSnapshot, AppError> {
    background(app.clone(), move |service| {
        service.expire_session()?; service.refresh_connection()?;
        let snapshot = service.snapshot();
        if crate::infrastructure::startup::background_launch() && (!snapshot.session.authenticated || !snapshot.session.onboarding_complete) { crate::tray::show_main(&app); }
        Ok(snapshot)
    }).await
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VpnAuthInput { username: String, password: String }
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredIdentity { access_token: String, account_id: String, expires_at: u64 }
#[derive(serde::Serialize)]
pub struct AcceptedSession { #[serde(flatten)] session: Session, remembered: bool }
#[tauri::command]
pub async fn accept_account_session(expires_at: u64, vpn_auth: Option<VpnAuthInput>, access_token: String, account_id: String, app: AppHandle) -> Result<AcceptedSession, AppError> {
    let (vpn_username, vpn_password) = vpn_auth.map(|auth| (auth.username, auth.password)).unwrap_or_default();
    let saved = crate::infrastructure::session::SavedSession { expires_at, token: access_token, account_id, vpn_username, vpn_password, onboarding: false };
    saved.validate()?;
    background(app.clone(), move |service| {
        let directory = app.path().app_data_dir().map_err(|_| AppError::new("session_storage_unavailable", "Session storage is unavailable."))?;
        // Invalidate any older saved account before accepting a different login.
        crate::infrastructure::session::forget(&directory)?;
        let session = service.accept_account_session(expires_at)?;
        if let Some(credentials) = saved.credentials()? { service.accept_vpn_credentials(credentials)?; }
        let remembered = crate::infrastructure::session::save(&directory, &saved).is_ok();
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let mut cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        cache.attempted = true; cache.saved = Some(saved);
        Ok(AcceptedSession { session, remembered })
    }).await
}
#[tauri::command]
pub async fn restore_account_session(app: AppHandle) -> Result<Option<RestoredIdentity>, AppError> {
    background(app.clone(), move |service| {
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let mut cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        if !cache.attempted {
            let directory = app.path().app_data_dir().map_err(|_| AppError::new("session_storage_unavailable", "Session storage is unavailable."))?;
            cache.saved = crate::infrastructure::session::load(&directory)?;
            cache.attempted = true;
            if let Some(saved) = &cache.saved {
                service.accept_account_session(saved.expires_at)?;
                if let Some(credentials) = saved.credentials()? { service.accept_vpn_credentials(credentials)?; }
                if saved.onboarding { service.complete_onboarding()?; }
            }
        }
        service.expire_session()?;
        if !service.snapshot().session.authenticated { cache.saved = None; return Ok(None); }
        Ok(cache.saved.as_ref().map(|saved| RestoredIdentity { access_token: saved.token.clone(), account_id: saved.account_id.clone(), expires_at: saved.expires_at.saturating_mul(1000) }))
    }).await
}
#[tauri::command]
pub async fn has_vpn_auth(expected_token: String, app: AppHandle) -> Result<bool, AppError> {
    background(app.clone(), move |service| {
        service.expire_session()?;
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        let saved = cache.saved.as_ref().filter(|saved| saved.token == expected_token)
            .ok_or_else(|| AppError::new("invalid_session", "Session changed."))?;
        saved.validate()?;
        Ok(saved.credentials()?.is_some())
    }).await
}
#[tauri::command]
pub async fn accept_vpn_auth(vpn_auth: VpnAuthInput, expected_token: String, app: AppHandle) -> Result<bool, AppError> {
    background(app.clone(), move |service| {
        service.expire_session()?;
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let mut cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        let saved = cache.saved.as_mut().filter(|saved| saved.token == expected_token)
            .ok_or_else(|| AppError::new("invalid_session", "Session changed."))?;
        saved.validate()?;
        // A late or duplicate response must never replace working credentials.
        if saved.credentials()?.is_some() { return Ok(true); }
        let credentials = stellar_core::openvpn::VpnCredentials::new(vpn_auth.username.clone(), vpn_auth.password.clone())?;
        service.accept_vpn_credentials(credentials)?;
        saved.vpn_username = vpn_auth.username;
        saved.vpn_password = vpn_auth.password;
        let directory = app.path().app_data_dir().map_err(|_| AppError::new("session_storage_unavailable", "Session storage is unavailable."))?;
        // Same session/expiry/onboarding; never call accept_account_session here.
        // Keep in-memory credentials usable if the protected OS vault is locked.
        Ok(crate::infrastructure::session::save(&directory, saved).is_ok())
    }).await
}
#[tauri::command]
pub async fn prepare_vpn_configuration(server_id: String, config: String, location_name: Option<String>, rotation: Option<bool>, app: AppHandle) -> Result<(), AppError> {
    let config = stellar_core::openvpn::ValidatedConfig::parse(&config)?;
    if let Some(name) = location_name {
        app.state::<crate::notifications::Notifications>().register_location(&server_id, &name);
    }
    background(app, move |service| if rotation == Some(true) { service.prepare_rotation(&server_id, config) } else { service.prepare_vpn_server(&server_id, config) }).await
}
#[tauri::command]
pub async fn read_cached_account(app: AppHandle) -> Result<Option<String>, AppError> {
    background(app.clone(), move |service| {
        service.expire_session()?;
        if !service.snapshot().session.authenticated { return Ok(None); }
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        let Some(saved) = &cache.saved else { return Ok(None); };
        saved.validate()?;
        crate::infrastructure::session::load_account_cache(&saved.token)
    }).await
}
#[tauri::command]
pub async fn write_cached_account(account_data: String, expected_token: String, app: AppHandle) -> Result<(), AppError> {
    background(app.clone(), move |service| {
        service.expire_session()?;
        if !service.snapshot().session.authenticated { return Err(AppError::new("unauthenticated", "Log in before caching account data.")); }
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        let Some(saved) = &cache.saved else { return Err(AppError::new("unauthenticated", "Log in before caching account data.")); };
        saved.validate()?;
        if saved.token != expected_token { return Err(AppError::new("invalid_session", "Session changed.")); }
        crate::infrastructure::session::save_account_cache(&expected_token, &account_data)
    }).await
}
#[tauri::command]
pub async fn update_subscription_access(access: SubscriptionAccess, expected_token: String, app: AppHandle) -> Result<(), AppError> {
    background(app.clone(), move |service| {
        let session = app.state::<crate::infrastructure::session::RememberedSession>();
        let cache = session.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        if !cache.saved.as_ref().is_some_and(|saved| saved.token == expected_token) { return Err(AppError::new("invalid_session", "Session changed.")); }
        service.update_subscription_access(access)
    }).await
}
#[tauri::command]
pub async fn select_location(server_id: String, app: AppHandle) -> Result<(), AppError> {
    if !crate::infrastructure::vpn::known_server(&server_id) { return Err(AppError::new("invalid_server", "Unknown VPN server")); }
    background(app, move |service| service.select_server(&server_id)).await
}
#[tauri::command]
pub async fn connect_preview(server_id: String, timeout_ms: Option<u64>, app: AppHandle) -> Result<ConnectionSnapshot, AppError> {
    let budget = timeout_ms.unwrap_or(30_000);
    if !(1..=30_000).contains(&budget) { return Err(AppError::new("vpn_timeout", "Connection timed out after 30 seconds. Please try again.")); }
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget);
    crate::tray::connection_icon(&app, false);
    background(app.clone(), move |service| {
        let before = service.snapshot();
        let switched = before.connection.status == ConnectionStatus::Connected && before.connection.server_id.as_deref() != Some(&server_id);
        let event = if before.connection.status == ConnectionStatus::Connected {
            Notice::Switching(server_id.clone())
        } else { Notice::Connecting(server_id.clone()) };
        notice(&app, event);
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        let result = service.connect_with_timeout(&server_id, remaining);
        if !app.state::<crate::notifications::Notifications>().is_cancelling() { notice(&app, match &result {
            Ok(connection) if connection.status == ConnectionStatus::Connected => if switched { Notice::LocationChanged(server_id) } else { Notice::Connected(server_id) },
            Err(error) if error.code == "vpn_timeout" => Notice::TimedOut,
            _ => Notice::Failed,
        }); }
        result
    }).await
}
#[tauri::command]
pub async fn disconnect_preview(app: AppHandle) -> Result<ConnectionSnapshot, AppError> {
    background(app.clone(), move |service| {
        notice(&app, Notice::Disconnecting);
        let result = service.disconnect();
        notice(&app, if result.is_ok() { Notice::Disconnected } else { Notice::DisconnectFailed });
        result
    }).await
}
#[tauri::command]
pub async fn cancel_connection(app: AppHandle) -> Result<ConnectionSnapshot, AppError> {
    let notifications = app.state::<crate::notifications::Notifications>();
    notifications.set_cancelling(true);
    // Stop the helper without waiting behind the service's blocking connect call.
    let _ = tauri::async_runtime::spawn_blocking(crate::infrastructure::vpn::interrupt_connect_helper).await;
    let result = background(app.clone(), move |service| service.cancel_connection()).await;
    notifications.set_cancelling(false);
    // Manual cancellation is not a lost-connection notification. The returned
    // snapshot tells the UI whether the existing kill switch is still armed.
    result
}
#[tauri::command]
pub async fn save_settings(settings: Settings, app: AppHandle) -> Result<Settings, AppError> {
    background(app.clone(), move |service| {
        let previous = service.snapshot().settings;
        let saved = service.save_settings(settings)?;
        if let Err(error) = crate::infrastructure::startup::sync(&app, saved.auto_connect) {
            let _ = service.save_settings(previous);
            return Err(error);
        }
        Ok(saved)
    }).await
}
#[tauri::command]
pub async fn logout(expected_token: Option<String>, app: AppHandle) -> Result<Session, AppError> {
    background(app.clone(), move |service| {
        if let Some(expected) = &expected_token {
            let state = app.state::<crate::infrastructure::session::RememberedSession>();
            let cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
            if cache.saved.as_ref().map(|saved| saved.token.as_str()) != Some(expected.as_str()) { return Ok(service.snapshot().session); }
        }
        let directory = app.path().app_data_dir().map_err(|_| AppError::new("session_storage_unavailable", "Session storage is unavailable."))?;
        crate::infrastructure::session::forget(&directory)?;
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        let mut cache = state.0.lock().map_err(|_| AppError::new("state_unavailable", "Session storage is unavailable."))?;
        cache.saved = None; cache.attempted = true; drop(cache);
        let connected = service.snapshot().connection.status == ConnectionStatus::Connected;
        if connected { notice(&app, Notice::Disconnecting); }
        let result = service.logout();
        if connected { notice(&app, if result.is_ok() { Notice::Disconnected } else { Notice::DisconnectFailed }); }
        result
    }).await
}
#[tauri::command]
pub async fn complete_onboarding(app: AppHandle) -> Result<Session, AppError> {
    background(app.clone(), move |service| {
        let session = service.complete_onboarding()?;
        let state = app.state::<crate::infrastructure::session::RememberedSession>();
        if let Ok(mut cache) = state.0.lock() {
            if let Some(saved) = &mut cache.saved {
                saved.onboarding = true;
                if let Ok(directory) = app.path().app_data_dir() { let _ = crate::infrastructure::session::save(&directory, saved); }
            }
        }
        Ok(session)
    }).await
}

#[tauri::command]
pub fn show_main(app: AppHandle) { crate::tray::show_main(&app); }
#[tauri::command]
pub fn show_locations(app: AppHandle) {
    crate::tray::show_main(&app);
    let _ = app.emit_to("main", "show-locations", ());
}
#[tauri::command]
pub fn hide_tray(app: AppHandle) { if let Some(window) = app.get_webview_window("tray") { let _ = window.hide(); } }
#[tauri::command]
pub fn quit_preview(app: AppHandle) { app.exit(0); }

#[tauri::command]
pub fn open_stellar_link(url: String) -> Result<(), AppError> {
    crate::infrastructure::links::open(&url)
}
