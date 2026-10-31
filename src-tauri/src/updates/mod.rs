mod trust;
#[cfg(target_os = "macos")] mod process;
#[cfg(target_os = "macos")] mod macos;
#[cfg(target_os = "windows")] mod windows;
#[cfg(test)] mod tests;

use serde::Serialize;
use std::sync::{Mutex, Arc, atomic::{AtomicBool, Ordering}};
use stellar_core::domain::AppError;
use tauri::{Emitter, Manager};
use stellar_core::notifications::UpdateNotice;
fn notify(app: &tauri::AppHandle, notice: UpdateNotice) { if let Some(notices) = app.try_state::<crate::notifications::Notifications>() { notices.update(notice); } }

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pending_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, AppError> { Ok(app.path().app_data_dir().map_err(|_| trust::failure())?.join("ota-restart-pending")) }

pub fn after_restart(app: &tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        use std::{io::Read, os::unix::fs::OpenOptionsExt};
        let Ok(path) = pending_path(app) else { return; };
        let Ok(file) = std::fs::OpenOptions::new().read(true).custom_flags(0x100).open(&path) else { return; };
        if !file.metadata().is_ok_and(|m| m.is_file() && m.len() <= 64) { return; }
        let mut version = String::new();
        if file.take(65).read_to_string(&mut version).is_err() || trust::Version::parse(&version).is_err() { let _ = std::fs::remove_file(path); return; }
        // This marker never authorizes installation. It only reports success
        // when the newly running app's actual compiled version matches it.
        if std::fs::remove_file(path).is_err() { return; }
        notify(app, if trust::completed_version(&version, &app.package_info().version.to_string()) { UpdateNotice::Completed(version) } else { UpdateNotice::Failed });
    }
    #[cfg(target_os = "windows")]
    {
        use std::{io::Read, os::windows::fs::{OpenOptionsExt, MetadataExt}};
        let Ok(path) = pending_path(app) else { return; };
        let Ok(mut file) = std::fs::OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(&path) else { return; };
        if !file.metadata().is_ok_and(|m| m.is_file() && m.file_attributes() & 0x400 == 0 && m.len() <= 64) { return; }
        let mut version = String::new();
        let valid = (&mut file).take(65).read_to_string(&mut version).is_ok() && trust::Version::parse(&version).is_ok();
        drop(file); if std::fs::remove_file(path).is_err() { return; }
        if valid { notify(app, if trust::completed_version(&version, &app.package_info().version.to_string()) { UpdateNotice::Completed(version) } else { UpdateNotice::Failed }); }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))] let _ = app;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateView {
    phase: &'static str,
    current_version: String,
    version: Option<String>,
    notes: String,
    downloaded: usize,
    message: String,
}
struct Inner { view: UpdateView, candidate: Option<trust::Candidate>, #[cfg(target_os = "macos")] prepared: Option<macos::Workspace>, #[cfg(target_os = "windows")] windows_prepared: Option<windows::Workspace>, checked: Option<std::time::Instant> }
pub struct Updates { inner: Mutex<Inner>, cancel: Arc<AtomicBool>, restarting: AtomicBool }
impl Updates {
    pub fn new(version: String) -> Self {
        Self { inner: Mutex::new(Inner { view: UpdateView { phase: if cfg!(any(target_os = "macos", target_os = "windows")) { "idle" } else { "unsupported" }, current_version: version, version: None, notes: String::new(), downloaded: 0, message: String::new() }, candidate: None, #[cfg(target_os = "macos")] prepared: None, #[cfg(target_os = "windows")] windows_prepared: None, checked: None }), cancel: Arc::new(AtomicBool::new(false)), restarting: AtomicBool::new(false) }
    }
    pub fn restarting(&self) -> bool { self.restarting.load(Ordering::SeqCst) }
}
fn emit(app: &tauri::AppHandle, view: &UpdateView) { let _ = app.emit_to("main", "update-changed", view); }
fn busy() -> AppError { AppError::new("update_busy", "An update operation is already in progress.") }

// The existing app-lifetime monitor calls this without depending on webview
// timers. It creates no new LaunchAgent, daemon or other persistence.
pub fn background_due(app: &tauri::AppHandle, resumed: bool) {
    if !cfg!(any(target_os = "macos", target_os = "windows")) { return; }
    let due = app.try_state::<Updates>().and_then(|state| state.inner.try_lock().ok().map(|inner| resumed || inner.checked.is_none_or(|t| t.elapsed().as_secs() >= 4 * 60 * 60))).unwrap_or(false);
    if due { let app = app.clone(); tauri::async_runtime::spawn(async move { let _ = check_update(app).await; }); }
}

#[tauri::command]
pub async fn check_update(app: tauri::AppHandle) -> Result<UpdateView, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Updates>();
        let mut inner = state.inner.try_lock().map_err(|_| busy())?;
        if !cfg!(any(target_os = "macos", target_os = "windows")) { return Ok(inner.view.clone()); }
        if inner.checked.is_some_and(|t| t.elapsed().as_secs() < 30) || inner.view.phase == "ready" { return Ok(inner.view.clone()); }
        state.cancel.store(false, Ordering::SeqCst);
        inner.checked = Some(std::time::Instant::now());
        inner.view.phase = "checking"; inner.view.message.clear(); emit(&app, &inner.view);
        #[cfg(target_os = "macos")]
        {
            let result = (|| {
                let mut last = Err(trust::unavailable());
                for attempt in 0..2 {
                    last = process::capture(process::curl(trust::FEED, trust::MAX_MANIFEST, 10), false, trust::MAX_MANIFEST, 12, state.cancel.clone());
                    if last.is_ok() || state.cancel.load(Ordering::SeqCst) { break; }
                    if attempt == 0 { std::thread::sleep(std::time::Duration::from_millis(400)); }
                }
                trust::manifest(&last?, &inner.view.current_version, trust::platform())
            })();
            match result {
                Ok(Some(candidate)) => {
                    inner.view.phase = "available"; inner.view.version = Some(candidate.version.clone()); inner.view.notes = candidate.notes.clone();
                    inner.candidate = Some(candidate);
                },
                Ok(None) => { inner.view.phase = "current"; inner.view.version = None; inner.view.notes.clear(); inner.candidate = None; },
                Err(error) => { inner.view.phase = if inner.candidate.is_some() { "available" } else { "error" }; inner.view.message = error.message.to_owned(); },
            }
        }
        #[cfg(target_os = "windows")]
        {
            let result = windows::fetch_manifest(state.cancel.clone()).and_then(|bytes| trust::manifest(&bytes, &inner.view.current_version, trust::platform()));
            match result {
                Ok(Some(candidate)) => { inner.view.phase = "available"; inner.view.version = Some(candidate.version.clone()); inner.view.notes = candidate.notes.clone(); inner.candidate = Some(candidate); }
                Ok(None) => { inner.view.phase = "current"; inner.view.version = None; inner.view.notes.clear(); inner.candidate = None; }
                Err(error) => { inner.view.phase = if inner.candidate.is_some() { "available" } else { "error" }; inner.view.message = error.message; }
            }
        }
        emit(&app, &inner.view); Ok(inner.view.clone())
    }).await.map_err(|_| trust::unavailable())?
}

#[tauri::command]
pub async fn download_update(app: tauri::AppHandle) -> Result<UpdateView, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Updates>();
        let mut inner = state.inner.try_lock().map_err(|_| busy())?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        { let _ = &mut inner; return Err(AppError::new("update_unsupported", "In-app updates are not available on this platform yet.")); }
        #[cfg(target_os = "windows")]
        {
            let candidate = inner.candidate.clone().ok_or_else(trust::failure)?;
            if trust::Version::parse(&candidate.version)? <= trust::Version::parse(&inner.view.current_version)? { return Err(trust::failure()); }
            if inner.windows_prepared.is_some() { return Ok(inner.view.clone()); }
            state.cancel.store(false, Ordering::SeqCst); inner.view.phase = "downloading"; inner.view.downloaded = 0; emit(&app, &inner.view);
            notify(&app, UpdateNotice::Downloading(candidate.version.clone()));
            let directory = app.path().app_data_dir().map_err(|_| trust::failure())?; let mut last_emit = std::time::Instant::now();
            match windows::download(&directory, &candidate, state.cancel.clone(), |count| {
                inner.view.downloaded = count;
                if last_emit.elapsed().as_millis() >= 200 { emit(&app, &inner.view); last_emit = std::time::Instant::now(); }
            }) {
                Ok(workspace) => { inner.windows_prepared = Some(workspace); inner.view.phase = "ready"; inner.view.message = "Signature verified. Disconnect VPN before installing.".into(); notify(&app, UpdateNotice::Ready(candidate.version)); }
                Err(error) => { inner.view.phase = "available"; inner.view.message = if state.cancel.load(Ordering::SeqCst) { "Download cancelled. Nothing was installed.".into() } else { notify(&app, UpdateNotice::Failed); error.message }; }
            }
            emit(&app, &inner.view); Ok(inner.view.clone())
        }
        #[cfg(target_os = "macos")]
        {
            use std::{fs::OpenOptions, io::Write, os::unix::fs::OpenOptionsExt};
            let candidate = inner.candidate.clone().ok_or_else(trust::failure)?;
            if trust::Version::parse(&candidate.version)? <= trust::Version::parse(&inner.view.current_version)? { return Err(trust::failure()); }
            if inner.prepared.is_some() { return Ok(inner.view.clone()); }
            state.cancel.store(false, Ordering::SeqCst);
            inner.view.phase = "downloading"; inner.view.downloaded = 0; inner.view.message.clear(); emit(&app, &inner.view);
            notify(&app, UpdateNotice::Downloading(candidate.version.clone()));
            let result = (|| {
                let directory = app.path().app_data_dir().map_err(|_| trust::failure())?;
                let workspace = macos::Workspace::new(&directory)?;
                let path = workspace.0.join("package.tar.gz");
                let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).map_err(|_| trust::failure())?;
                let key = trust::public_key()?;
                let signature = trust::signature(&candidate.signature)?;
                let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?;
                let mut last_emit = std::time::Instant::now();
                process::run(process::curl(&candidate.url, trust::MAX_PACKAGE, 120), false, trust::MAX_PACKAGE, 125, state.cancel.clone(), |chunk| {
                    file.write_all(chunk).map_err(|_| trust::failure())?;
                    verifier.update(chunk); inner.view.downloaded += chunk.len();
                    if last_emit.elapsed().as_millis() >= 200 { emit(&app, &inner.view); last_emit = std::time::Instant::now(); }
                    Ok(())
                })?;
                if inner.view.downloaded == 0 { return Err(trust::failure()); }
                verifier.finalize().map_err(|_| trust::failure())?;
                trust::signed_version(&signature, &candidate.version)?;
                file.sync_all().map_err(|_| trust::failure())?;
                Ok(workspace)
            })();
            match result {
                Ok(prepared) => { inner.prepared = Some(prepared); inner.view.phase = "ready"; inner.view.message = "Signature verified. Disconnect VPN before installing.".into(); notify(&app, UpdateNotice::Ready(candidate.version.clone())); },
                Err(error) => { inner.view.phase = "available"; inner.view.message = if state.cancel.load(Ordering::SeqCst) { "Download cancelled. Nothing was installed.".into() } else { notify(&app, UpdateNotice::Failed); error.message.into() }; },
            }
            emit(&app, &inner.view); Ok(inner.view.clone())
        }
    }).await.map_err(|_| trust::unavailable())?
}

#[tauri::command]
pub fn cancel_update(app: tauri::AppHandle) { app.state::<Updates>().cancel.store(true, Ordering::SeqCst); }

#[tauri::command]
pub async fn install_update(app: tauri::AppHandle) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Updates>();
        let mut inner = state.inner.try_lock().map_err(|_| busy())?;
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        { let _ = &mut inner; return Err(AppError::new("update_unsupported", "In-app updates are not available on this platform yet.")); }
        #[cfg(target_os = "windows")]
        {
            let desktop = app.state::<crate::AppState>(); let service = desktop.0.try_lock().map_err(|_| busy())?;
            if !trust::installation_allowed(&service.snapshot().connection) { return Err(AppError::new("update_disconnect_required", "Disconnect VPN before installing the update. Your connection was not changed.")); }
            let candidate = inner.candidate.clone().ok_or_else(trust::failure)?;
            if trust::Version::parse(&candidate.version)? <= trust::Version::parse(&inner.view.current_version)? { return Err(trust::failure()); }
            let workspace = inner.windows_prepared.as_mut().ok_or_else(trust::failure)?;
            state.cancel.store(false, Ordering::SeqCst);
            let _locked_package = windows::verified_lock(workspace, &candidate, state.cancel.clone())?;
            let marker = pending_path(&app)?;
            {
                use std::{io::Write, os::windows::fs::OpenOptionsExt};
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000).open(&marker).map_err(|_| trust::failure())?;
                file.write_all(candidate.version.as_bytes()).and_then(|_| file.sync_all()).map_err(|_| trust::failure())?;
            }
            if let Err(error) = crate::infrastructure::windows::launch_installer(&workspace.package()) { let _ = std::fs::remove_file(marker); return Err(error); }
            workspace.launched = true; inner.view.phase = "installing"; emit(&app, &inner.view); notify(&app, UpdateNotice::Installing(candidate.version));
            state.restarting.store(true, Ordering::SeqCst);
            if let Some(notices) = app.try_state::<crate::notifications::Notifications>() { notices.stop(); }
            if let Some(guard) = app.try_state::<crate::infrastructure::startup::InstanceGuard>() { guard.release_for_restart(); }
            app.exit(0); Ok(())
        }
        #[cfg(target_os = "macos")]
        {
            // Serialize with native connection actions right through replacement.
            // Never disconnect or release the firewall to make an update work.
            let desktop = app.state::<crate::AppState>();
            let service = desktop.0.try_lock().map_err(|_| busy())?;
            let snapshot = service.snapshot();
            if !trust::installation_allowed(&snapshot.connection) {
                return Err(AppError::new("update_disconnect_required", "Disconnect VPN before installing the update. Your connection was not changed."));
            }
            let prepared = inner.prepared.as_ref().ok_or_else(trust::failure)?;
            let candidate = inner.candidate.as_ref().ok_or_else(trust::failure)?;
            state.cancel.store(false, Ordering::SeqCst);
            let path = prepared.0.join("package.tar.gz");
            // Re-verify staged bytes after any time spent waiting for the user.
            let result = (|| {
                use std::io::Read;
                let mut file = std::fs::File::open(&path).map_err(|_| trust::failure())?;
                if file.metadata().map_err(|_| trust::failure())?.len() > trust::MAX_PACKAGE as u64 { return Err(trust::failure()); }
                let key = trust::public_key()?;
                let signature = trust::signature(&candidate.signature)?;
                let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?;
                let mut bytes = [0; 32 * 1024];
                loop { let n = file.read(&mut bytes).map_err(|_| trust::failure())?; if n == 0 { break; } verifier.update(&bytes[..n]); }
                verifier.finalize().map_err(|_| trust::failure())?;
                trust::signed_version(&signature, &candidate.version)?;
                if trust::Version::parse(&candidate.version)? <= trust::Version::parse(&inner.view.current_version)? { return Err(trust::failure()); }
                macos::replace(&path, candidate, state.cancel.clone(), || {
                    use std::{io::Write, os::unix::fs::OpenOptionsExt};
                    let mut marker = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(pending_path(&app)?).map_err(|_| trust::failure())?;
                    marker.write_all(candidate.version.as_bytes()).and_then(|_| marker.sync_all()).map_err(|_| trust::failure())?;
                    notify(&app, UpdateNotice::Installing(candidate.version.clone()));
                    Ok(())
                })
            })();
            if let Err(error) = result {
                if let Ok(marker) = pending_path(&app) { let _ = std::fs::remove_file(marker); }
                notify(&app, UpdateNotice::Failed);
                inner.view.phase = "available"; inner.view.message = error.message.clone(); inner.prepared = None;
                emit(&app, &inner.view); return Err(error);
            }
            inner.view.phase = "installing"; emit(&app, &inner.view);
            // Release our explicit instance lock before LaunchServices starts the
            // new version. There is no active VPN/firewall intent at this point.
            state.restarting.store(true, Ordering::SeqCst);
            if let Some(notices) = app.try_state::<crate::notifications::Notifications>() { notices.stop(); }
            if let Some(guard) = app.try_state::<crate::infrastructure::startup::InstanceGuard>() { guard.release_for_restart(); }
            // Keep the service mutex locked until process exit, so no late
            // connection command can race the user-approved restart.
            let _service = service;
            app.restart();
        }
    }).await.map_err(|_| trust::unavailable())?
}
