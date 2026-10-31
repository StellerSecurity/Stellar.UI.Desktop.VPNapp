//! Reads only the known old Tauri store. No profile scan, password reuse or network.
use std::{fs, io::{Read, Write}, path::Path};
use stellar_core::domain::AppError;
const LIMIT: u64 = 65536;
const AUTH_KEYS: &[&str] = &["bearer_token", "stellar_vpn_username", "stellar_vpn_password", "account_number", "device_name"];
fn failure() -> AppError { AppError::new("migration_unavailable", "Login migration could not finish. Your previous login was kept.") }
pub fn enabled() -> bool {
    cfg!(any(target_os = "macos", target_os = "windows")) && tauri::utils::config::parse::parse_json_value(include_str!("../../legacy-migration.json"), Path::new("legacy-migration.json"))
        .ok().and_then(|v| v.get("enabled").and_then(|v| v.as_bool())) == Some(true)
}
fn valid(value: &str) -> bool {
    let Some((id, secret)) = value.split_once('|') else { return false; };
    !id.is_empty() && id.len() <= 32 && !id.starts_with('0') && id.bytes().all(|b| b.is_ascii_digit())
        && secret.len() == 40 && secret.bytes().all(|b| b.is_ascii_alphanumeric())
}
pub fn valid_token(value: &str) -> bool { valid(value) }
fn parse(raw: &str) -> Result<Option<String>, AppError> {
    if raw.len() > LIMIT as usize { return Err(failure()); }
    let value = tauri::utils::config::parse::parse_json_value(raw, Path::new("legacy.json")).map_err(|_| failure())?;
    let object = value.as_object().ok_or_else(failure)?;
    match object.get("bearer_token") {
        None => Ok(None),
        Some(v) => v.as_str().filter(|s| valid(s)).map(|s| Some(s.to_owned())).ok_or_else(failure),
    }
}
#[cfg(target_os = "macos")]
fn read(directory: &Path) -> Result<Option<String>, AppError> {
    use std::os::unix::fs::{OpenOptionsExt, MetadataExt};
    let path = directory.join(".stellar-vpn.dat");
    let file = match fs::OpenOptions::new().read(true).custom_flags(0x100).open(path) {
        Ok(file) => file, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None), Err(_) => return Err(failure()),
    };
    let meta = file.metadata().map_err(|_| failure())?;
    if !meta.is_file() || meta.nlink() != 1 || meta.len() > LIMIT { return Err(failure()); }
    let mut raw = String::new();
    file.take(LIMIT + 1).read_to_string(&mut raw).map_err(|_| failure())?;
    if raw.len() as u64 > LIMIT { return Err(failure()); }
    Ok(Some(raw))
}
pub fn token(directory: &Path) -> Result<Option<String>, AppError> {
    if !enabled() || directory.join("session-forgotten").exists() || directory.join("legacy-login-migrated").exists() { return Ok(None); }
    #[cfg(target_os = "macos")]
    { return read(directory)?.map(|raw| parse(&raw)).transpose().map(Option::flatten); }
    #[cfg(target_os = "windows")]
    { return super::windows::legacy_read(&directory.join(".stellar-vpn.dat"))?.map(|raw| parse(&raw)).transpose().map(Option::flatten); }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Ok(None)
}
/// Call only after the native command has re-read and checked the durable v2 vault session.
pub fn finish(directory: &Path, expected_legacy: Option<&str>) -> Result<(), AppError> {
    if !enabled() { return Err(failure()); }
    finish_store(directory, expected_legacy)
}
fn finish_store(directory: &Path, expected_legacy: Option<&str>) -> Result<(), AppError> {
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::{OpenOptionsExt, MetadataExt};
        let source = directory.join(".stellar-vpn.dat");
        let before = fs::symlink_metadata(&source).ok();
        if let Some(raw) = read(directory)? {
            let before = before.ok_or_else(failure)?;
            let old = parse(&raw)?;
            // A previous attempt may have cleaned the file before a crash; never touch a different token.
            if old.is_some() && old.as_deref() != expected_legacy { return Err(failure()); }
            let mut value = tauri::utils::config::parse::parse_json_value(&raw, Path::new("legacy.json")).map_err(|_| failure())?;
            let object = value.as_object_mut().ok_or_else(failure)?;
            for key in AUTH_KEYS { object.remove(*key); }
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| failure())?.as_nanos();
            let temporary = directory.join(format!(".stellar-migration-{}-{nonce}", std::process::id()));
            let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&temporary).map_err(|_| failure())?;
            let result = (|| {
                file.write_all(value.to_string().as_bytes()).map_err(|_| failure())?;
                file.sync_all().map_err(|_| failure())?;
                let after = fs::symlink_metadata(&source).map_err(|_| failure())?;
                if after.file_type().is_symlink() || before.ino() != after.ino() || before.len() != after.len()
                    || before.mtime() != after.mtime() || before.mtime_nsec() != after.mtime_nsec() { return Err(failure()); }
                fs::rename(&temporary, &source).map_err(|_| failure())
            })();
            if result.is_err() { let _ = fs::remove_file(&temporary); }
            result?;
        }
        let mut marker = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).custom_flags(0x100)
            .open(directory.join("legacy-login-migrated")).map_err(|_| failure())?;
        marker.write_all(b"1").map_err(|_| failure())?;
        marker.sync_all().map_err(|_| failure())?;
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::{OpenOptionsExt, MetadataExt};
        if let Some(raw) = super::windows::legacy_read(&directory.join(".stellar-vpn.dat"))? {
            let old = parse(&raw)?;
            if old.is_some() && old.as_deref() != expected_legacy { return Err(failure()); }
            let mut value = tauri::utils::config::parse::parse_json_value(&raw, Path::new("legacy.json")).map_err(|_| failure())?;
            let object = value.as_object_mut().ok_or_else(failure)?;
            for key in AUTH_KEYS { object.remove(*key); }
            super::windows::legacy_replace(&directory.join(".stellar-vpn.dat"), &raw, &value.to_string())?;
        }
        let mut marker = match fs::OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000)
            .open(directory.join("legacy-login-migrated")) {
                Ok(file) => file,
                // Never truncate an existing file or hard link. The new vault
                // session is already durable and legacy cleanup ran above.
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
                Err(_) => return Err(failure()),
            };
        let meta = marker.metadata().map_err(|_| failure())?;
        if !meta.is_file() || meta.file_attributes() & 0x400 != 0 { return Err(failure()); }
        marker.write_all(b"1").and_then(|_| marker.sync_all()).map_err(|_| failure())?;
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = (directory, expected_legacy); Err(failure()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_bounded_legacy_bearers_are_importable() {
        let token = format!("7|{}", "a".repeat(40));
        assert_eq!(parse(&format!(r#"{{"bearer_token":"{token}","account_number":"untrusted"}}"#)).unwrap(), Some(token));
        assert_eq!(parse(r#"{"theme":"dark"}"#).unwrap(), None);
        for raw in ["[]", "null", r#"{"bearer_token":4}"#, r#"{"bearer_token":"7|short"}"#] { assert!(parse(raw).is_err()); }
        assert!(parse(&" ".repeat(LIMIT as usize + 1)).is_err());
        assert!(!valid(&format!("07|{}", "a".repeat(40))));
    }
    #[cfg(target_os = "macos")]
    #[test] fn cleanup_preserves_preferences_and_refuses_changed_tokens_or_links() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let directory = std::env::temp_dir().join(format!("stellar-migration-selftest-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir(&directory).unwrap();
        let source = directory.join(".stellar-vpn.dat");
        let old = format!("7|{}", "a".repeat(40));
        let raw = format!(r#"{{"bearer_token":"{old}","stellar_vpn_password":"synthetic","theme":"dark","auto_connect":true}}"#);
        fs::write(&source, &raw).unwrap();
        assert!(finish_store(&directory, Some("wrong")).is_err());
        assert_eq!(fs::read_to_string(&source).unwrap(), raw);
        finish_store(&directory, Some(&old)).unwrap();
        let cleaned = fs::read_to_string(&source).unwrap();
        assert!(!cleaned.contains(&old) && !cleaned.contains("synthetic"));
        assert!(cleaned.contains("dark") && cleaned.contains("auto_connect"));
        assert_eq!(fs::metadata(&source).unwrap().permissions().mode() & 0o777, 0o600);
        // Resume after file cleanup but before clearing the durable vault receipt.
        finish_store(&directory, Some(&old)).unwrap();
        fs::remove_file(&source).unwrap();
        let outside = directory.join("unrelated-selftest");
        fs::write(&outside, &raw).unwrap(); symlink(&outside, &source).unwrap();
        assert!(read(&directory).is_err());
        assert_eq!(fs::read_to_string(&outside).unwrap(), raw);
        fs::remove_file(&source).unwrap(); fs::remove_file(&outside).unwrap();
        fs::remove_file(directory.join("legacy-login-migrated")).unwrap(); fs::remove_dir(directory).unwrap();
    }
}
