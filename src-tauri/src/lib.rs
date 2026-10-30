mod commands;
mod infrastructure;
mod tray;
mod notifications;
mod updates;

use std::sync::Mutex;
use stellar_core::application::DesktopService;
use tauri::Manager;

pub struct AppState(Mutex<DesktopService>);

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            #[cfg(target_os = "macos")]
            match infrastructure::startup::instance(&directory).map_err(|error| std::io::Error::other(error.message))? {
                Some(guard) => { app.manage(guard); },
                None => { app.handle().exit(0); return Ok(()); },
            }
            // Restore account access separately; never inherit an orphaned tunnel.
            let _ = infrastructure::vpn::disconnect_helper();
            let service = DesktopService::new(
                Box::new(infrastructure::preferences::FilePreferences::new(directory)),
                Box::new(infrastructure::vpn::OpenVpnEngine::default()),
            ).map_err(|error| std::io::Error::other(error.message))?;
            infrastructure::startup::sync(app.handle(), service.snapshot().settings.auto_connect).map_err(|error| std::io::Error::other(error.message))?;
            let notices = notifications::Notifications::new(
                service.snapshot().settings.notifications,
                notifications::SystemNotificationSink::new(app.config().identifier.clone()),
            );
            notices.language(&service.snapshot().settings.language);
            app.manage(AppState(Mutex::new(service)));
            app.manage(infrastructure::session::RememberedSession(Mutex::new(infrastructure::session::SessionCache::default())));
            app.manage(notices.clone());
            app.manage(updates::Updates::new(app.package_info().version.to_string()));
            updates::after_restart(app.handle());
            tray::setup(app)?;
            notices.monitor(app.handle());
            if infrastructure::startup::background_launch() { tray::hide_main(app.handle()); }
            else { tray::show_main(app.handle()); }
            #[cfg(debug_assertions)]
            if std::env::args().any(|arg| arg == "--notification-smoke-test") { notices.smoke_test(); }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap, commands::select_location, commands::connect_preview, commands::disconnect_preview, commands::update_subscription_access,
            commands::save_settings, commands::accept_account_session, commands::has_vpn_auth, commands::accept_vpn_auth,
            commands::restore_account_session,
            commands::read_cached_account, commands::write_cached_account,
            commands::prepare_vpn_configuration,
            commands::logout, commands::complete_onboarding, commands::open_stellar_link, commands::cancel_connection,
            commands::show_main, commands::show_locations, commands::hide_tray, commands::quit_preview,
            updates::check_update, updates::download_update, updates::install_update, updates::cancel_update
        ])
        .build(tauri::generate_context!())
        .expect("Unable to start Stellar VPN desktop")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                if let Some(notifications) = app.try_state::<notifications::Notifications>() { notifications.stop(); }
                let update_restart = app.try_state::<updates::Updates>().is_some_and(|state| state.restarting());
                if !update_restart && app.try_state::<AppState>().is_some() { let _ = infrastructure::vpn::disconnect_helper(); }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) { tray::show_main(app); }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
