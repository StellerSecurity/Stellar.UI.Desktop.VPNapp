//! Native delivery coordinator. No credentials, addresses or account data enter notices.
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};
use std::time::Duration;
use stellar_core::{domain::{ConnectionSnapshot, ConnectionStatus}, notifications::{Notice, NotificationPolicy}};
use tauri::{AppHandle, Emitter, Manager};

pub trait NotificationSink: Send + Sync + 'static {
    fn show(&self, message: &str) -> Result<(), ()>;
}

fn localized_notice(language: &str, message: &str) -> String {
    let names = ["English", "Dansk", "Deutsch", "Türkçe", "Español", "Svenska", "Norsk (bokmål)", "Français", "Italiano", "Nederlands", "Polski", "Português (Brasil)"];
    let index = names.iter().position(|name| *name == language).unwrap_or(0);
    if index == 0 { return message.to_owned(); }
    // Compile-time, first-party translation data only; no JavaScript is executed here.
    for line in include_str!("../../src/shared/i18n/notices.ts").lines() {
        let cells: Vec<_> = line.split('|').collect();
        if cells.len() != names.len() { continue; }
        if cells[0] == message { return cells[index].to_owned(); }
        if let Some((prefix, suffix)) = cells[0].split_once("{value}") {
            if let Some(value) = message.strip_prefix(prefix).and_then(|value| value.strip_suffix(suffix)) {
                return cells[index].replace("{value}", value);
            }
        }
    }
    message.to_owned()
}

#[cfg(test)]
mod localization_tests {
    use super::localized_notice;
    #[test] fn native_notices_follow_the_saved_language_and_preserve_values() {
        assert_eq!(localized_notice("Dansk", "Connected to Norway – Oslo."), "Forbundet til Norway – Oslo.");
        assert_eq!(localized_notice("Português (Brasil)", "Stellar VPN was updated to 1.2.3."), "A Stellar VPN foi atualizada para 1.2.3.");
        assert_eq!(localized_notice("unknown", "VPN disconnected."), "VPN disconnected.");
    }
}

#[cfg(test)]
mod update_tests {
    use super::*;
    use stellar_core::notifications::UpdateNotice;
    struct RecordingSink(Arc<Mutex<Vec<String>>>);
    impl NotificationSink for RecordingSink { fn show(&self, message: &str) -> Result<(), ()> { self.0.lock().unwrap().push(message.to_owned()); Ok(()) } }
    #[test] fn update_delivery_uses_the_existing_sink_without_network_data_or_duplicate_progress() {
        let messages = Arc::new(Mutex::new(Vec::new()));
        let notices = Notifications::new(true, RecordingSink(messages.clone()));
        notices.update(UpdateNotice::Downloading("1.2.3".into()));
        notices.update(UpdateNotice::Downloading("1.2.3".into()));
        notices.update(UpdateNotice::Ready("1.2.3".into()));
        notices.enabled(false); notices.update(UpdateNotice::Failed);
        notices.enabled(true); notices.update(UpdateNotice::Installing("1.2.3".into()));
        notices.stop(); notices.update(UpdateNotice::Completed("1.2.3".into()));
        assert_eq!(messages.lock().unwrap().len(), 3);
    }
}

/// Only this adapter knows the OS notification library. No shell commands,
/// remote images, bundle-name lookups or persistent startup services are used.
pub struct SystemNotificationSink { app_id: String, ready: bool }
impl SystemNotificationSink {
    pub fn new(app_id: String) -> Self {
        #[cfg(target_os = "macos")]
        let ready = notify_rust::set_application(&app_id).is_ok();
        #[cfg(not(target_os = "macos"))]
        let ready = true;
        if !ready { eprintln!("Stellar VPN: notification identity could not be initialized."); }
        Self { app_id, ready }
    }
}
impl NotificationSink for SystemNotificationSink {
    fn show(&self, message: &str) -> Result<(), ()> {
        if !self.ready { return Err(()); }
        let mut notification = notify_rust::Notification::new();
        notification.appname("Stellar VPN").summary("Stellar VPN").body(message);
        #[cfg(target_os = "windows")]
        notification.app_id(&self.app_id);
        #[cfg(target_os = "linux")]
        notification.timeout(notify_rust::Timeout::Milliseconds(6000));
        #[cfg(not(target_os = "windows"))]
        let _ = &self.app_id;
        notification.show().map(|_| ()).map_err(|_| ())
    }
}

#[derive(Clone)]
pub struct Notifications {
    update_policy: Arc<Mutex<stellar_core::notifications::UpdateNotificationPolicy>>,
    locations: Arc<Mutex<std::collections::HashMap<String, String>>>,
    policy: Arc<Mutex<NotificationPolicy>>,
    enabled: Arc<AtomicBool>,
    stopped: Arc<AtomicBool>,
    sink: Arc<dyn NotificationSink>,
    language: Arc<Mutex<String>>,
    cancelling: Arc<AtomicBool>,
}

impl Notifications {
    pub fn new(enabled: bool, sink: impl NotificationSink) -> Self {
        Self { update_policy: Arc::default(), locations: Arc::default(), policy: Arc::default(), enabled: Arc::new(AtomicBool::new(enabled)), stopped: Arc::new(AtomicBool::new(false)), sink: Arc::new(sink), language: Arc::new(Mutex::new("English".into())), cancelling: Arc::new(AtomicBool::new(false)) }
    }
    pub fn set_cancelling(&self, value: bool) { self.cancelling.store(value, Ordering::Release); }
    pub fn is_cancelling(&self) -> bool { self.cancelling.load(Ordering::Acquire) }
    pub fn language(&self, language: &str) { if let Ok(mut current) = self.language.lock() { *current = language.to_owned(); } }
    fn localized(&self, message: &str) -> String {
        let language = self.language.lock().map(|value| value.clone()).unwrap_or_else(|_| "English".into());
        localized_notice(&language, message)
    }

    pub fn register_location(&self, id: &str, name: &str) {
        if !crate::infrastructure::vpn::known_server(id) || name.trim().is_empty() || name.len() > 160 || name.chars().any(char::is_control) { return; }
        if let Ok(mut locations) = self.locations.lock() {
            if locations.len() < 1000 || locations.contains_key(id) { locations.insert(id.into(), name.trim().into()); }
        }
    }

    pub fn enabled(&self, enabled: bool) { self.enabled.store(enabled, Ordering::Release); }
    pub fn stop(&self) { self.stopped.store(true, Ordering::Release); }
    pub fn update(&self, notice: stellar_core::notifications::UpdateNotice) {
        if self.stopped.load(Ordering::Acquire) { return; }
        let message = self.update_policy.lock().ok().and_then(|mut policy| policy.message(notice, self.enabled.load(Ordering::Acquire)));
        if let Some(message) = message { if self.sink.show(&self.localized(&message)).is_err() { eprintln!("Stellar VPN: update notification was not delivered."); } }
    }

    #[cfg(debug_assertions)]
    pub fn smoke_test(&self) {
        let coordinator = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(3));
            if coordinator.stopped.load(Ordering::Acquire) { return; }
            // Explicit local diagnostic only; no IPC/frontend command exposes
            // this and release builds do not include it. OS focus/permission
            // settings can still suppress the banner after accepting a request.
            match coordinator.sink.show("Notifications are ready.") {
                Ok(()) => eprintln!("Stellar VPN notification smoke test: request accepted by native backend."),
                Err(()) => eprintln!("Stellar VPN notification smoke test: native backend rejected request."),
            }
        });
    }

    pub fn monitor(&self, app: &AppHandle) {
        let coordinator = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            let mut last_tick = std::time::SystemTime::now();
            let mut last_account_check = last_tick;
            let mut resume_pending = false;
            let mut network_changes = crate::infrastructure::network::NetworkChanges::new().ok();
            if network_changes.is_none() { eprintln!("Stellar VPN: native network change monitoring unavailable."); }
            while !coordinator.stopped.load(Ordering::Acquire) {
                std::thread::sleep(Duration::from_secs(2));
                if coordinator.stopped.load(Ordering::Acquire) { break; }
                let now = std::time::SystemTime::now();
                let resumed = now.duration_since(last_tick).unwrap_or_default() >= Duration::from_secs(10);
                resume_pending |= resumed;
                // Event-based link/address changes survive short Wi-Fi switches
                // and a suspended webview. Keep them pending across service locks.
                if network_changes.as_mut().is_some_and(|changes| changes.changed()) { resume_pending = true; }
                if resumed || now.duration_since(last_account_check).unwrap_or_default() >= Duration::from_secs(60) {
                    // A pulse, not an HTTP request. The main adapter gates real
                    // background reads to four hours and coalesces resume/focus.
                    let _ = app.emit("account-refresh-due", if resumed { "resume" } else { "periodic" });
                    crate::updates::background_due(&app, resumed);
                    last_account_check = now;
                }
                last_tick = now;
                let state = app.state::<crate::AppState>();
                // Connecting owns the service until it completes; monitoring
                // must not queue behind it or interfere with its timeout.
                let Ok(mut service) = state.0.try_lock() else { continue; };
                if coordinator.is_cancelling() { continue; }
                let before = service.snapshot();
                let _ = service.expire_session();
                // Retain the resume event if a connect operation owned the lock.
                if resume_pending && service.recover_after_resume().is_ok() { resume_pending = false; }
                let _ = service.refresh_connection();
                if let Some(attempt) = service.due_recovery(std::time::Instant::now()) {
                    let id = attempt.server_id;
                    let _ = app.emit("native-connection-state", Some(&id));
                    crate::tray::connection_icon(&app, false);
                    // No notification storm while Wi-Fi is unavailable.
                    if attempt.first { coordinator.transition(&app, Notice::Connecting(id.clone())); }
                    let result = service.recover_connection(&id);
                    match result {
                        Ok(connection) if connection.status == ConnectionStatus::Connected => { coordinator.transition(&app, Notice::Connected(id)); },
                        _ if attempt.first => { coordinator.transition(&app, if service.snapshot().connection.traffic_blocked { Notice::Blocked } else { Notice::Failed }); },
                        _ => {},
                    }
                    let _ = app.emit("native-connection-state", Option::<String>::None);
                }
                if let Some(id) = service.due_rotation(std::time::Instant::now()) {
                    let _ = app.emit("native-connection-state", Some(&id));
                    crate::tray::connection_icon(&app, false);
                    coordinator.transition(&app, Notice::Switching(id.clone()));
                    let result = service.connect(&id);
                    coordinator.transition(&app, match result {
                        Ok(connection) if connection.status == ConnectionStatus::Connected => Notice::LocationChanged(id),
                        Err(error) if error.code == "vpn_timeout" => Notice::TimedOut,
                        _ => Notice::Failed,
                    });
                    let _ = app.emit("native-connection-state", Option::<String>::None);
                }
                let after = service.snapshot();
                drop(service);
                coordinator.enabled(after.settings.notifications);
                if before.session.authenticated && !after.session.authenticated {
                    coordinator.transition(&app, if after.connection.traffic_blocked { Notice::Blocked } else { Notice::Disconnected });
                }
                coordinator.observe(&app, &before.connection, &after.connection);
                // Monitoring continues even when both webviews are suspended.
                let _ = app.emit("desktop-changed", after);
                crate::tray::refresh(&app);
                // Connection work may take 30 seconds. Its duration is not sleep.
                last_tick = std::time::SystemTime::now();
            }
        });
    }

    pub fn transition(&self, app: &AppHandle, notice: Notice) {
        let delayed = notice.delayed();
        let revision = match self.policy.lock().ok().and_then(|mut policy| policy.transition(notice)) {
            Some(revision) => revision, None => return,
        };
        let coordinator = self.clone();
        let app = app.clone();
        std::thread::spawn(move || {
            if delayed { std::thread::sleep(Duration::from_secs(2)); }
            if coordinator.stopped.load(Ordering::Acquire) { return; }
            // Foreground UI already gives feedback. Hidden, minimized or unfocused
            // windows need OS delivery; showing a window is not the same as focus.
            let foreground = app.get_webview_window("main").is_some_and(|window| {
                window.is_visible().unwrap_or(false)
                    && !window.is_minimized().unwrap_or(false)
                    && window.is_focused().unwrap_or(false)
            });
            let message = coordinator.policy.lock().ok().and_then(|policy| {
                policy.deliver(revision, foreground, coordinator.enabled.load(Ordering::Acquire)).map(|notice| {
                    let locations = coordinator.locations.lock().ok();
                    let name = notice.server_id().and_then(|id| locations.as_ref()?.get(id));
                    notice.message_for_location(name.map(String::as_str))
                })
            });
            if let Some(message) = message {
                if coordinator.sink.show(&coordinator.localized(&message)).is_err() {
                    // Delivery denial is not a tunnel failure. Never log OS error
                    // payloads, credentials or retry repeatedly when permission is denied.
                    eprintln!("Stellar VPN: system notification was not delivered.");
                }
            }
        });
    }

    pub fn observe(&self, app: &AppHandle, before: &ConnectionSnapshot, after: &ConnectionSnapshot) {
        if after.status == ConnectionStatus::Connected {
            if before.status != ConnectionStatus::Connected || before.server_id != after.server_id {
                if let Some(id) = &after.server_id {
                    let announced = self.policy.lock().map(|policy| policy.connection_announced(id)).unwrap_or(true);
                    if !announced { self.transition(app, Notice::Connected(id.clone())); }
                }
            }
        } else if before.status == ConnectionStatus::Connected {
            // Explicit disconnects, failed location switches and timeouts have
            // their own notices. Only an unexplained tunnel loss becomes Lost.
            let unexpected = self.policy.lock().map(|policy| {
                policy.unexpected_disconnect()
            }).unwrap_or(false);
            if unexpected { self.transition(app, if after.traffic_blocked { Notice::Blocked } else { Notice::Lost }); }
        }
    }
}
