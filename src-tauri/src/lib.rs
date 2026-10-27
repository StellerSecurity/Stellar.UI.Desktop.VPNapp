mod commands;
mod infrastructure;
mod tray;

use std::sync::Mutex;
use stellar_core::application::DesktopService;
use tauri::Manager;

pub struct AppState(Mutex<DesktopService>);

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            let service = DesktopService::new(
                Box::new(infrastructure::preferences::FilePreferences::new(directory)),
                Box::new(infrastructure::vpn::PreviewVpnEngine),
            ).map_err(|error| std::io::Error::other(error.message))?;
            app.manage(AppState(Mutex::new(service)));
            tray::setup(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap, commands::select_location, commands::connect_preview, commands::disconnect_preview,
            commands::save_settings, commands::accept_account_session,
            commands::logout, commands::complete_onboarding, commands::open_stellar_link,
            commands::show_main, commands::show_locations, commands::hide_tray, commands::quit_preview
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Stellar VPN desktop")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) { tray::show_main(app); }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
