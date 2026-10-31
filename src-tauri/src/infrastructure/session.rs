//! App-scoped session vault. Never stores the account login password or writes
//! bearer/VPN secrets to preferences, command arguments, logs or plain files.
use std::{fs, path::Path, sync::Mutex};
use stellar_core::{domain::AppError, openvpn::VpnCredentials};

// Do not read/migrate the macOS v1 item: its ad hoc-build ACL can trigger
// authorization on every rebuild. A fresh login creates v2 under the stable
// certificate identity, with normal Keychain encryption and default access.
// Leave the old encrypted item untouched rather than widening its ACL.
#[cfg(all(not(test), target_os = "macos"))]
const SERVICE: &str = "org.stellarvpn.desktop.session.v2";
#[cfg(all(not(test), not(target_os = "macos")))]
const SERVICE: &str = "org.stellarvpn.desktop.preview.session.v1";
#[cfg(test)]
const SERVICE: &str = "org.stellarvpn.desktop.session.selftest.v2";
const ACCOUNT: &str = "current-session";
const LIMIT: usize = 2048;
const DISPLAY_LIMIT: usize = 49_152;
#[cfg(not(test))]
// v1 was created by ad hoc development builds: preserving its ACL also
// preserves their obsolete code identity and causes repeated access prompts.
// Rebuild display-only data under the certificate-backed identity instead.
// Never read/delete the old item as migration.
const DISPLAY_SERVICE: &str = "org.stellarvpn.desktop.account-cache.v2";
#[cfg(test)]
const DISPLAY_SERVICE: &str = "org.stellarvpn.desktop.account-cache.selftest.v2";
fn unavailable() -> AppError { AppError::new("session_storage_unavailable", "Couldn’t remember this login securely.") }
fn now() -> u64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs() }

pub struct SavedSession {
    pub expires_at: u64,
    pub token: String,
    pub account_id: String,
    pub vpn_username: String,
    pub vpn_password: String,
    pub onboarding: bool,
    // Temporary cleanup receipt, protected in the same OS vault as the new session.
    pub legacy_token: Option<String>,
}
impl SavedSession {
    pub fn validate(&self) -> Result<(), AppError> {
        if let Some(legacy) = &self.legacy_token {
            if legacy == &self.token || !super::legacy_login::valid_token(legacy) { return Err(unavailable()); }
        }
        let (id, secret) = self.token.split_once('|').ok_or_else(unavailable)?;
        if self.expires_at <= now() || id.is_empty() || id.starts_with('0') || !id.bytes().all(|c| c.is_ascii_digit())
            || id.len() > 32 || secret.len() != 40 || !secret.bytes().all(|c| c.is_ascii_alphanumeric())
            || self.account_id.is_empty() || self.account_id.len() > 32 || self.account_id.starts_with('0')
            || !self.account_id.bytes().all(|c| c.is_ascii_digit()) { return Err(unavailable()); }
        if !self.vpn_username.is_empty() || !self.vpn_password.is_empty() {
            VpnCredentials::new(self.vpn_username.clone(), self.vpn_password.clone())?;
        }
        Ok(())
    }
    pub fn credentials(&self) -> Result<Option<VpnCredentials>, AppError> {
        if self.vpn_username.is_empty() { Ok(None) }
        else { VpnCredentials::new(self.vpn_username.clone(), self.vpn_password.clone()).map(Some) }
    }
    fn encode(&self) -> Result<Vec<u8>, AppError> {
        self.validate()?;
        Ok(format!("2\n{}\n{}\n{}\n{}\n{}\n{}\n{}", self.expires_at, self.token, self.account_id, self.vpn_username, self.vpn_password, u8::from(self.onboarding), self.legacy_token.as_deref().unwrap_or("")).into_bytes())
    }
    fn decode(bytes: &[u8]) -> Result<Self, AppError> {
        if bytes.len() > LIMIT { return Err(unavailable()); }
        let fields: Vec<_> = std::str::from_utf8(bytes).map_err(|_| unavailable())?.split('\n').collect();
        if !((fields.len() == 7 && fields[0] == "1") || (fields.len() == 8 && fields[0] == "2")) || !matches!(fields[6], "0" | "1") { return Err(unavailable()); }
        let value = Self { expires_at: fields[1].parse().map_err(|_| unavailable())?, token: fields[2].into(), account_id: fields[3].into(), vpn_username: fields[4].into(), vpn_password: fields[5].into(), onboarding: fields[6] == "1", legacy_token: fields.get(7).filter(|s| !s.is_empty()).map(|s| s.to_string()) };
        value.validate()?;
        Ok(value)
    }
}
impl Drop for SavedSession {
    fn drop(&mut self) {
        for text in [&mut self.token, &mut self.vpn_username, &mut self.vpn_password] {
            for byte in unsafe { text.as_bytes_mut() } { unsafe { std::ptr::write_volatile(byte, 0) }; }
        }
        if let Some(legacy) = &mut self.legacy_token { unsafe { legacy.as_bytes_mut().fill(0) }; }
    }
}
#[derive(Default)]
pub struct SessionCache { pub attempted: bool, pub saved: Option<SavedSession> }
pub struct RememberedSession(pub Mutex<SessionCache>);

// A non-secret tombstone makes logout durable even if the OS keychain is locked
// or refuses deletion. It never contains a token, account ID or password.
pub fn forget(directory: &Path) -> Result<(), AppError> {
    fs::create_dir_all(directory).map_err(|_| unavailable())?;
    fs::write(directory.join("session-forgotten"), b"1").map_err(|_| unavailable())?;
    let _ = platform::remove();
    #[cfg(target_os = "macos")]
    let _ = platform::remove_for(DISPLAY_SERVICE);
    Ok(())
}
pub fn save(directory: &Path, value: &SavedSession) -> Result<(), AppError> {
    value.validate()?;
    // Same-session updates must preserve its display cache and existing ACLs.
    // A new login explicitly calls forget before accepting another session.
    fs::create_dir_all(directory).map_err(|_| unavailable())?;
    fs::write(directory.join("session-forgotten"), b"1").map_err(|_| unavailable())?;
    let mut bytes = value.encode()?;
    let result = platform::save(&bytes);
    for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
    result?;
    fs::remove_file(directory.join("session-forgotten")).map_err(|_| unavailable())
}
pub fn load(directory: &Path) -> Result<Option<SavedSession>, AppError> {
    if directory.join("session-forgotten").exists() { return Ok(None); }
    let Some(mut bytes) = platform::load()? else { return Ok(None); };
    let result = SavedSession::decode(&bytes);
    for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
    match result { Ok(value) => Ok(Some(value)), Err(_) => { forget(directory)?; Ok(None) } }
}
/// Only clears a cleanup receipt on an already validated durable session.
/// A failed optional cleanup must never set the logout guard or erase that session.
pub fn clear_migration_receipt(value: &SavedSession) -> Result<(), AppError> {
    value.validate()?;
    if value.legacy_token.is_some() { return Err(unavailable()); }
    let mut bytes = value.encode()?;
    let result = platform::save(&bytes);
    for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
    result
}

pub fn load_account_cache(expected_token: &str) -> Result<Option<String>, AppError> {
    #[cfg(target_os = "macos")]
    {
        let Some(mut bytes) = platform::load_for(DISPLAY_SERVICE, DISPLAY_LIMIT + LIMIT)? else { return Ok(None); };
        let value = std::str::from_utf8(&bytes).ok().and_then(|text| text.split_once('\n'))
            .filter(|(owner, data)| *owner == expected_token && data.len() <= DISPLAY_LIMIT)
            .map(|(_, data)| data.to_owned());
        for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
        Ok(value)
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = expected_token; Ok(None) }
}
pub fn save_account_cache(expected_token: &str, data: &str) -> Result<(), AppError> {
    if expected_token.len() > 256 || expected_token.contains(['\n', '\r']) || data.len() > DISPLAY_LIMIT
        || !data.starts_with('{') || !data.ends_with('}') || data.chars().any(char::is_control) { return Err(unavailable()); }
    #[cfg(target_os = "macos")]
    {
        let mut bytes = format!("{expected_token}\n{data}").into_bytes();
        let result = platform::save_for(DISPLAY_SERVICE, &bytes, DISPLAY_LIMIT + LIMIT);
        for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; }
        result
    }
    #[cfg(not(target_os = "macos"))]
    Err(unavailable())
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{ffi::{c_char, c_void}, ptr};
    // Signatures verified against the installed Apple SDK SecKeychain headers.
    // OS keychain encryption/access controls are left intact; no ACL widening.
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainFindGenericPassword(keychain: *const c_void, service_len: u32, service: *const c_char, account_len: u32, account: *const c_char, length: *mut u32, data: *mut *mut c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainAddGenericPassword(keychain: *const c_void, service_len: u32, service: *const c_char, account_len: u32, account: *const c_char, length: u32, data: *const c_void, item: *mut *mut c_void) -> i32;
        fn SecKeychainItemFreeContent(attributes: *mut c_void, data: *mut c_void) -> i32;
        fn SecKeychainItemDelete(item: *mut c_void) -> i32;
        fn SecKeychainItemModifyAttributesAndData(item: *mut c_void, attributes: *const c_void, length: u32, data: *const c_void) -> i32;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" { fn CFRelease(value: *const c_void); }
    const NOT_FOUND: i32 = -25300;
    pub fn load() -> Result<Option<Vec<u8>>, AppError> {
        load_for(SERVICE, LIMIT)
    }
    pub fn load_for(service: &str, limit: usize) -> Result<Option<Vec<u8>>, AppError> {
        let (mut length, mut data) = (0, ptr::null_mut());
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr().cast(), ACCOUNT.len() as u32, ACCOUNT.as_ptr().cast(), &mut length, &mut data, ptr::null_mut()) };
        if status == NOT_FOUND { return Ok(None); }
        if status != 0 { return Err(unavailable()); }
        let result = if data.is_null() || length as usize > limit { Err(unavailable()) }
            else { Ok(Some(unsafe { std::slice::from_raw_parts(data.cast::<u8>(), length as usize) }.to_vec())) };
        if !data.is_null() { unsafe { SecKeychainItemFreeContent(ptr::null_mut(), data) }; }
        result
    }
    pub fn remove() -> Result<(), AppError> {
        remove_for(SERVICE)
    }
    pub fn remove_for(service: &str) -> Result<(), AppError> {
        let mut item = ptr::null_mut();
        let status = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr().cast(), ACCOUNT.len() as u32, ACCOUNT.as_ptr().cast(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        if status == NOT_FOUND { return Ok(()); }
        if status != 0 || item.is_null() { return Err(unavailable()); }
        let status = unsafe { SecKeychainItemDelete(item) };
        unsafe { CFRelease(item) };
        if status == 0 || status == NOT_FOUND { Ok(()) } else { Err(unavailable()) }
    }
    pub fn save(bytes: &[u8]) -> Result<(), AppError> {
        save_for(SERVICE, bytes, LIMIT)
    }
    pub fn save_for(service: &str, bytes: &[u8], limit: usize) -> Result<(), AppError> {
        if bytes.len() > limit { return Err(unavailable()); }
        let mut item = ptr::null_mut();
        let found = unsafe { SecKeychainFindGenericPassword(ptr::null(), service.len() as u32, service.as_ptr().cast(), ACCOUNT.len() as u32, ACCOUNT.as_ptr().cast(), ptr::null_mut(), ptr::null_mut(), &mut item) };
        // Preserve existing OS ACLs when updating an item; never enumerate or
        // widen access to make caching succeed.
        if found == 0 && !item.is_null() {
            let status = unsafe { SecKeychainItemModifyAttributesAndData(item, ptr::null(), bytes.len() as u32, bytes.as_ptr().cast()) };
            unsafe { CFRelease(item) };
            return if status == 0 { Ok(()) } else { Err(unavailable()) };
        }
        if found != NOT_FOUND { return Err(unavailable()); }
        let status = unsafe { SecKeychainAddGenericPassword(ptr::null(), service.len() as u32, service.as_ptr().cast(), ACCOUNT.len() as u32, ACCOUNT.as_ptr().cast(), bytes.len() as u32, bytes.as_ptr().cast(), ptr::null_mut()) };
        if status == 0 { Ok(()) } else { Err(unavailable()) }
    }
}
#[cfg(target_os = "windows")]
#[path = "session_windows.rs"]
mod platform;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod platform {
    use super::*;
    // Fail closed on platforms without an implemented credential-vault adapter.
    // Never downgrade to plaintext/localStorage to simulate persistence.
    pub fn load() -> Result<Option<Vec<u8>>, AppError> { Ok(None) }
    pub fn save(_: &[u8]) -> Result<(), AppError> { Err(unavailable()) }
    pub fn remove() -> Result<(), AppError> { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn sample() -> SavedSession { SavedSession { expires_at: u64::MAX, token: format!("42|{}", "a".repeat(40)), account_id: "42".into(), vpn_username: format!("stvpn_{}", "a".repeat(16)), vpn_password: "b".repeat(32), onboarding: true, legacy_token: None } }
    #[test] fn v1_vault_sessions_remain_readable_and_migration_receipts_are_validated() {
        let original = sample();
        let old = format!("1\n{}\n{}\n{}\n{}\n{}\n1", original.expires_at, original.token, original.account_id, original.vpn_username, original.vpn_password);
        assert!(SavedSession::decode(old.as_bytes()).unwrap().legacy_token.is_none());
        let mut migrated = sample();
        migrated.legacy_token = Some(format!("7|{}", "c".repeat(40)));
        let restored = SavedSession::decode(&migrated.encode().unwrap()).unwrap();
        assert_eq!(restored.legacy_token, migrated.legacy_token);
        migrated.legacy_token = Some(migrated.token.clone()); assert!(migrated.validate().is_err());
        migrated.legacy_token = Some("invalid".into()); assert!(migrated.validate().is_err());
    }
    #[test] fn session_round_trip_is_bounded_and_keeps_original_expiry() {
        let value = sample(); let restored = SavedSession::decode(&value.encode().unwrap()).unwrap();
        assert_eq!(restored.expires_at, value.expires_at); assert_eq!(restored.token, value.token); assert!(restored.onboarding);
        assert!(restored.credentials().unwrap().is_some());
    }
    #[test] fn expired_malformed_and_injected_records_are_rejected() {
        let mut value = sample(); value.expires_at = 0; assert!(value.validate().is_err());
        assert!(SavedSession::decode(&vec![b'x'; LIMIT + 1]).is_err());
        let value = sample(); let mut bytes = value.encode().unwrap(); bytes.extend_from_slice(b"\nextra");
        assert!(SavedSession::decode(&bytes).is_err());
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Explicit OS Keychain integration test; uses only the isolated Stellar selftest item"]
    fn keychain_round_trip_and_delete() {
        platform::remove().unwrap();
        assert!(platform::load().unwrap().is_none());
        platform::save(b"stellar-session-roundtrip-fixture").unwrap();
        assert!(platform::load().unwrap().unwrap() == b"stellar-session-roundtrip-fixture");
        platform::remove().unwrap();
        assert!(platform::load().unwrap().is_none());
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Explicit protected account-cache test; isolated Stellar selftest item only"]
    fn account_cache_round_trip_is_session_bound() {
        platform::remove_for(DISPLAY_SERVICE).unwrap();
        let token = format!("42|{}", "a".repeat(40));
        save_account_cache(&token, "{\"account_id\":\"42\"}").unwrap();
        assert_eq!(load_account_cache(&token).unwrap().as_deref(), Some("{\"account_id\":\"42\"}"));
        assert!(load_account_cache("another-session").unwrap().is_none());
        save_account_cache(&token, "{\"account_id\":\"42\",\"updated\":true}").unwrap();
        assert!(load_account_cache(&token).unwrap().unwrap().contains("updated"));
        assert!(save_account_cache(&token, &"x".repeat(DISPLAY_LIMIT + 1)).is_err());
        platform::remove_for(DISPLAY_SERVICE).unwrap();
        assert!(load_account_cache(&token).unwrap().is_none());
    }
    #[cfg(target_os = "windows")]
    #[test]
    #[ignore = "Explicit Windows Credential Manager test; isolated Stellar selftest item only"]
    fn windows_vault_round_trip_and_delete() {
        platform::remove().unwrap();
        assert!(platform::load().unwrap().is_none());
        platform::save(b"stellar-session-roundtrip-fixture").unwrap();
        assert!(platform::load().unwrap().unwrap() == b"stellar-session-roundtrip-fixture");
        platform::remove().unwrap();
        assert!(platform::load().unwrap().is_none());
    }
}
