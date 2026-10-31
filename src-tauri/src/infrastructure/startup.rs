//! User-approved login startup. Never runs as root and never keeps relaunching
//! an app the user deliberately quit. Only our exact registration is changed.
use stellar_core::domain::AppError;
use std::path::Path;
const LABEL: &str = "org.stellarvpn.desktop.autostart";
fn failed() -> AppError { AppError::new("startup_unavailable", "Could not update automatic startup. Check your macOS login items and try again.") }

fn plist(executable: &Path) -> Result<String, AppError> {
    let path = executable.to_str().filter(|path| executable.is_absolute() && !path.chars().any(char::is_control)).ok_or_else(failed)?;
    let path = path.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;");
    Ok(format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict>\n<key>Label</key><string>{LABEL}</string>\n<key>ProgramArguments</key><array><string>{path}</string><string>--autostart</string></array>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><false/>\n<key>LimitLoadToSessionType</key><string>Aqua</string>\n<key>ProcessType</key><string>Interactive</string>\n</dict></plist>\n"))
}

#[cfg(target_os = "macos")]
fn sync_at(home: &Path, executable: &Path, enabled: bool) -> Result<(), AppError> {
    use std::{fs, io::Write, os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt}};
    unsafe extern "C" { fn geteuid() -> u32; }
    let directory = home.join("Library/LaunchAgents");
    let target = directory.join(format!("{LABEL}.plist"));
    if !directory.exists() && !enabled { return Ok(()); }
    fs::create_dir_all(&directory).map_err(|_| failed())?;
    let metadata = fs::symlink_metadata(&directory).map_err(|_| failed())?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { geteuid() } || metadata.mode() & 0o022 != 0 { return Err(failed()); }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.uid() != unsafe { geteuid() } => return Err(failed()),
        Ok(_) => {},
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(_) => return Err(failed()),
    }
    if !enabled {
        return match fs::remove_file(target) { Ok(()) => Ok(()), Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()), Err(_) => Err(failed()) };
    }
    let content = plist(executable)?;
    if fs::read_to_string(&target).ok().as_deref() == Some(&content) { return Ok(()); }
    let temporary = directory.join(format!("{LABEL}.{}.pending", std::process::id()));
    let result = (|| {
        let mut file = fs::OpenOptions::new().create_new(true).write(true).mode(0o600).open(&temporary)?;
        file.write_all(content.as_bytes())?; file.sync_all()?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o644))?;
        fs::rename(&temporary, &target)
    })();
    if result.is_err() { let _ = fs::remove_file(temporary); }
    result.map_err(|_| failed())
}

pub fn sync(app: &tauri::AppHandle, enabled: bool) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let executable = std::env::current_exe().map_err(|_| failed())?;
        // Development runners must not register cargo/target/debug executables.
        if !executable.to_string_lossy().contains(".app/Contents/MacOS/") { return Ok(()); }
        sync_at(&app.path().home_dir().map_err(|_| failed())?, &executable, enabled)
    }
    #[cfg(target_os = "windows")]
    { let _ = app; super::windows::autostart(enabled) }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (app, enabled); Ok(()) }
}

pub fn background_launch() -> bool { std::env::args().any(|arg| arg == "--autostart") }

#[cfg(target_os = "windows")]
pub struct InstanceGuard(std::sync::Mutex<Option<isize>>);
#[cfg(target_os = "windows")]
impl InstanceGuard {
    pub fn release_for_restart(&self) {
        if let Some(handle) = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take() { super::windows::close_instance(handle); }
    }
}
#[cfg(target_os = "windows")]
impl Drop for InstanceGuard { fn drop(&mut self) { self.release_for_restart(); } }
#[cfg(target_os = "windows")]
pub fn instance(_: &Path) -> Result<Option<InstanceGuard>, AppError> { super::windows::instance().map(|value| value.map(|h| InstanceGuard(std::sync::Mutex::new(Some(h))))) }

#[cfg(target_os = "macos")]
pub struct InstanceGuard(std::sync::Mutex<Option<std::fs::File>>);
#[cfg(target_os = "macos")]
impl InstanceGuard {
    pub fn release_for_restart(&self) {
        let mut file = self.0.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        drop(file.take());
    }
}
#[cfg(target_os = "macos")]
pub fn instance(directory: &Path) -> Result<Option<InstanceGuard>, AppError> {
    use std::{fs, os::{fd::AsRawFd, unix::fs::OpenOptionsExt}};
    unsafe extern "C" { fn flock(fd: i32, operation: i32) -> i32; }
    fs::create_dir_all(directory).map_err(|_| failed())?;
    let file = fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).mode(0o600).custom_flags(0x100).open(directory.join("desktop-instance.lock")).map_err(|_| failed())?;
    if unsafe { flock(file.as_raw_fd(), 2 | 4) } != 0 {
        let error = std::io::Error::last_os_error();
        return if error.kind() == std::io::ErrorKind::WouldBlock { Ok(None) } else { Err(failed()) };
    }
    Ok(Some(InstanceGuard(std::sync::Mutex::new(Some(file)))))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn registration_uses_one_literal_argument_and_no_shell_or_relaunch_loop() {
        let xml = plist(Path::new("/Applications/Stellar & VPN.app/Contents/MacOS/Stellar VPN")).unwrap();
        assert!(xml.contains("Stellar &amp; VPN.app"));
        assert!(xml.contains("<string>--autostart</string>"));
        assert!(xml.contains("<key>KeepAlive</key><false/>"));
        assert!(!xml.contains("/bin/sh"));
        assert!(plist(Path::new("relative")).is_err());
        assert!(plist(Path::new("/Applications/bad\npath")).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test] fn registration_is_reversible_and_instance_lock_prevents_duplicate_tunnels() {
        let directory = std::env::temp_dir().join(format!("stellar-startup-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let executable = Path::new("/Applications/Stellar VPN.app/Contents/MacOS/Stellar VPN");
        sync_at(&directory, executable, true).unwrap();
        let registration = directory.join("Library/LaunchAgents").join(format!("{LABEL}.plist"));
        assert!(registration.is_file());
        sync_at(&directory, executable, false).unwrap();
        assert!(!registration.exists());
        let guard = instance(&directory).unwrap().unwrap();
        assert!(instance(&directory).unwrap().is_none());
        drop(guard);
        assert!(instance(&directory).unwrap().is_some());
        std::fs::remove_file(directory.join("desktop-instance.lock")).unwrap();
        std::fs::remove_dir(directory.join("Library/LaunchAgents")).unwrap();
        std::fs::remove_dir(directory.join("Library")).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }
}
