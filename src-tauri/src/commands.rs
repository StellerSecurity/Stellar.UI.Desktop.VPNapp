use std::sync::MutexGuard;
use stellar_core::{application::DesktopService, domain::*};
use tauri::{State, AppHandle, Emitter, Manager};
use crate::AppState;

fn service<'a>(state: &'a State<'_, AppState>) -> Result<MutexGuard<'a, DesktopService>, AppError> {
    state.0.lock().map_err(|_| AppError::new("state_unavailable", "Desktop state is unavailable"))
}
fn mutate<T>(app: &AppHandle, state: &State<'_, AppState>, action: impl FnOnce(&mut DesktopService) -> Result<T, AppError>) -> Result<T, AppError> {
    let mut service = service(state)?;
    let result = action(&mut service)?;
    let snapshot = service.snapshot();
    drop(service);
    let _ = app.emit("desktop-changed", snapshot);
    crate::tray::refresh(app);
    Ok(result)
}
#[tauri::command]
pub fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<DesktopSnapshot, AppError> {
    mutate(&app, &state, |service| { service.expire_session()?; Ok(service.snapshot()) })
}
#[tauri::command]
pub fn accept_account_session(expires_at: u64, app: AppHandle, state: State<'_, AppState>) -> Result<Session, AppError> {
    mutate(&app, &state, |service| service.accept_account_session(expires_at))
}
#[tauri::command]
pub fn select_location(server_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), AppError> {
    if !crate::infrastructure::vpn::known_server(&server_id) { return Err(AppError::new("invalid_server", "Unknown VPN server")); }
    mutate(&app, &state, |service| service.select_server(&server_id))
}
#[tauri::command]
pub fn connect_preview(server_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<ConnectionSnapshot, AppError> { mutate(&app, &state, |service| service.connect(&server_id)) }
#[tauri::command]
pub fn disconnect_preview(app: AppHandle, state: State<'_, AppState>) -> Result<ConnectionSnapshot, AppError> { mutate(&app, &state, |service| service.disconnect()) }
#[tauri::command]
pub fn save_settings(settings: Settings, app: AppHandle, state: State<'_, AppState>) -> Result<Settings, AppError> { mutate(&app, &state, |service| service.save_settings(settings)) }
#[tauri::command]
pub fn logout(app: AppHandle, state: State<'_, AppState>) -> Result<Session, AppError> { mutate(&app, &state, |service| service.logout()) }
#[tauri::command]
pub fn complete_onboarding(app: AppHandle, state: State<'_, AppState>) -> Result<Session, AppError> { mutate(&app, &state, |service| service.complete_onboarding()) }

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
