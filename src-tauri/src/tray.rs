//! Native shell only. VPN state and decisions stay in DesktopService.
use tauri::{Manager, Emitter, WebviewUrl, WebviewWindowBuilder, WindowEvent,
    tray::{TrayIconBuilder, TrayIconEvent, MouseButton, MouseButtonState},
    menu::{Menu, MenuItem}, image::Image, PhysicalPosition};
use crate::AppState;
use stellar_core::domain::ConnectionStatus;

fn status_icon(connected: bool) -> Image<'static> {
    // Retain the original mark and alpha mask; only its status tint changes.
    let mut pixels = include_bytes!("../icons/tray.rgba").to_vec();
    let color = if connected { [255, 255, 255] } else { [225, 0, 0] };
    for pixel in pixels.chunks_exact_mut(4) { pixel[..3].copy_from_slice(&color); }
    Image::new_owned(pixels, 32, 32)
}

pub fn connection_icon(app: &tauri::AppHandle, connected: bool) {
    if let Some(tray) = app.tray_by_id("stellar-tray") {
        // Template rendering would discard the requested red/white colors.
        let _ = tray.set_icon_with_as_template(Some(status_icon(connected)), false);
        let status = if connected { "Connected" } else { "Disconnected" };
        let _ = tray.set_tooltip(Some(format!("Stellar VPN — {status}")));
    }
}

pub fn show_main(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
    if let Some(popup) = app.get_webview_window("tray") { let _ = popup.hide(); }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize(); let _ = window.show(); let _ = window.set_focus();
    };
}

pub fn hide_main(app: &tauri::AppHandle) {
    if let Some(popup) = app.get_webview_window("tray") { let _ = popup.hide(); }
    if let Some(window) = app.get_webview_window("main") { let _ = window.hide(); }
    #[cfg(target_os = "macos")]
    let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    // Keep a way back even if the menu-bar preference was off in the open UI.
    if let Some(tray) = app.tray_by_id("stellar-tray") { let _ = tray.set_visible(true); }
}

fn tray_visible(menu_bar: bool, main_visible: bool) -> bool { menu_bar || !main_visible }

pub fn refresh(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if let Ok(service) = state.0.lock() {
        let snapshot = service.snapshot();
        if let Some(tray) = app.tray_by_id("stellar-tray") {
            let main_visible = app.get_webview_window("main").is_some_and(|window| window.is_visible().unwrap_or(false));
            let _ = tray.set_visible(tray_visible(snapshot.settings.menu_bar, main_visible));
            let connected = snapshot.connection.status == ConnectionStatus::Connected && snapshot.connection.server_id.is_some();
            connection_icon(app, connected);
        }
        if !snapshot.settings.menu_bar && app.get_webview_window("main").is_some_and(|window| window.is_visible().unwrap_or(false)) {
            if let Some(window) = app.get_webview_window("tray") { let _ = window.hide(); }
        }
    };
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    // Closing the main window leaves quick controls available for this session.
    // Login startup is managed separately by the Auto-connect preference.
    if let Some(main) = app.get_webview_window("main") {
        let handle = app.handle().clone();
        main.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main(&handle);
            }
        });
    }
    // Keyboard-accessible entry to the same tray controls.
    let app_menu = Menu::default(app.handle())?;
    let quick = MenuItem::with_id(app, "quick-controls", "Quick controls", true, Some("CmdOrCtrl+Shift+M"))?;
    for item in app_menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            if submenu.text()? == "View" { submenu.append(&quick)?; }
        }
    }
    app.set_menu(app_menu)?;
    app.on_menu_event(|app, event| {
        if event.id.as_ref() == "quick-controls" {
            if let Some(tray) = app.tray_by_id("stellar-tray") {
                if let Ok(Some(rect)) = tray.rect() { toggle_popup(app, rect); }
            }
        }
    });
    let popup = WebviewWindowBuilder::new(app, "tray", WebviewUrl::App("index.html?surface=tray".into()))
        .title("Stellar VPN — Quick controls").inner_size(320., 252.)
        .visible(false).decorations(false).resizable(false).skip_taskbar(true)
        .always_on_top(true).background_color(tauri::webview::Color(10, 52, 118, 255)).build()?;
    let dismiss = popup.clone();
    popup.on_window_event(move |event| {
        if matches!(event, WindowEvent::Focused(false)) { let _ = dismiss.hide(); }
    });
    let open = MenuItem::with_id(app, "open", "Open Stellar VPN", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Stellar VPN", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    TrayIconBuilder::with_id("stellar-tray")
        .icon(status_icon(false))
        .icon_as_template(false).tooltip("Stellar VPN — Disconnected")
        .menu(&menu).show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app), "quit" => app.exit(0), _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, rect, .. } = event {
                toggle_popup(tray.app_handle(), rect);
            }
        }).build(app)?;
    refresh(app.handle());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn hidden_window_always_keeps_the_tray_recovery_path() {
        assert!(tray_visible(true, false));
        assert!(tray_visible(false, false));
        assert!(tray_visible(true, true));
        assert!(!tray_visible(false, true));
    }
    #[test] fn status_tints_preserve_original_mark_alpha() {
        let original = include_bytes!("../icons/tray.rgba");
        for connected in [false, true] {
            let icon = status_icon(connected);
            let expected = if connected { [255, 255, 255] } else { [225, 0, 0] };
            for (pixel, source) in icon.rgba().chunks_exact(4).zip(original.chunks_exact(4)) {
                assert_eq!(&pixel[..3], &expected);
                assert_eq!(pixel[3], source[3]);
            }
        }
    }
}

fn toggle_popup(app: &tauri::AppHandle, rect: tauri::Rect) {
    if let Some(window) = app.get_webview_window("tray") {
                    if window.is_visible().unwrap_or(false) { let _ = window.hide(); return; }
                    let scale = window.scale_factor().unwrap_or(1.);
                    let point = rect.position.to_physical::<f64>(scale);
                    let size = rect.size.to_physical::<f64>(scale);
                    let mut x = point.x + size.width / 2. - 160. * scale;
                    let mut y = point.y + size.height + 6. * scale;
                    if let Ok(Some(monitor)) = app.monitor_from_point(point.x, point.y) {
                        let origin = monitor.position(); let bounds = monitor.size();
                        x = x.clamp(origin.x as f64 + 8., (origin.x as f64 + bounds.width as f64 - 320. * scale - 8.).max(origin.x as f64 + 8.));
                        y = y.min(origin.y as f64 + bounds.height as f64 - 252. * scale - 8.).max(origin.y as f64 + 8.);
                    }
                    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
                    let _ = window.show(); let _ = window.set_focus();
                    let _ = window.emit("tray-opened", ());
    }
}
