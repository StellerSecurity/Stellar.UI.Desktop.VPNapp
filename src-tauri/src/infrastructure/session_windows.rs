//! Uses only the current user's exact app-scoped Generic Credential, never enumeration.
//! ABI follows Microsoft's CREDENTIALW / CredReadW / CredWriteW documentation.
use super::*;
use std::{ffi::c_void, ptr};
const GENERIC: u32 = 1;
const LOCAL_MACHINE: u32 = 2; // Persists across logons for this user, not other users.
const NOT_FOUND: u32 = 1168;
#[repr(C)]
struct FileTime { low: u32, high: u32 }
#[repr(C)]
struct Credential {
    flags: u32, kind: u32, target: *mut u16, comment: *mut u16,
    written: FileTime, size: u32, blob: *mut u8, persist: u32,
    attribute_count: u32, attributes: *mut c_void, alias: *mut u16, username: *mut u16,
}
#[link(name = "Advapi32")]
unsafe extern "system" {
    fn CredReadW(target: *const u16, kind: u32, flags: u32, credential: *mut *mut Credential) -> i32;
    fn CredWriteW(credential: *const Credential, flags: u32) -> i32;
    fn CredDeleteW(target: *const u16, kind: u32, flags: u32) -> i32;
    fn CredFree(buffer: *mut c_void);
}
#[link(name = "Kernel32")]
unsafe extern "system" { fn GetLastError() -> u32; }
fn wide(value: &str) -> Vec<u16> { value.encode_utf16().chain(Some(0)).collect() }
struct OwnedCredential(*mut Credential);
impl Drop for OwnedCredential {
    fn drop(&mut self) {
        if self.0.is_null() { return; }
        unsafe {
            let credential = &mut *self.0;
            if !credential.blob.is_null() && credential.size as usize <= LIMIT {
                for byte in std::slice::from_raw_parts_mut(credential.blob, credential.size as usize) { ptr::write_volatile(byte, 0); }
            }
            CredFree(self.0.cast());
        }
    }
}
pub fn load() -> Result<Option<Vec<u8>>, AppError> { load_for(SERVICE, LIMIT) }
pub fn load_for(service: &str, limit: usize) -> Result<Option<Vec<u8>>, AppError> {
    if limit > LIMIT { return Err(unavailable()); }
    let target = wide(service); let mut raw = ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), GENERIC, 0, &mut raw) } == 0 {
        return if unsafe { GetLastError() } == NOT_FOUND { Ok(None) } else { Err(unavailable()) };
    }
    let owned = OwnedCredential(raw);
    if owned.0.is_null() { return Err(unavailable()); }
    let value = unsafe { &*owned.0 };
    if value.kind != GENERIC || value.size as usize > limit || value.blob.is_null() { return Err(unavailable()); }
    Ok(Some(unsafe { std::slice::from_raw_parts(value.blob, value.size as usize) }.to_vec()))
}
pub fn save(bytes: &[u8]) -> Result<(), AppError> { save_for(SERVICE, bytes, LIMIT) }
pub fn save_for(service: &str, bytes: &[u8], limit: usize) -> Result<(), AppError> {
    if limit > LIMIT || bytes.is_empty() || bytes.len() > limit { return Err(unavailable()); }
    let mut target = wide(service); let mut account = wide(ACCOUNT);
    let credential = Credential {
        flags: 0, kind: GENERIC, target: target.as_mut_ptr(), comment: ptr::null_mut(),
        written: FileTime { low: 0, high: 0 }, size: bytes.len() as u32,
        blob: bytes.as_ptr().cast_mut(), persist: LOCAL_MACHINE, attribute_count: 0,
        attributes: ptr::null_mut(), alias: ptr::null_mut(), username: account.as_mut_ptr(),
    };
    if unsafe { CredWriteW(&credential, 0) } != 0 { Ok(()) } else { Err(unavailable()) }
}
pub fn remove() -> Result<(), AppError> { remove_for(SERVICE) }
pub fn remove_for(service: &str) -> Result<(), AppError> {
    let target = wide(service);
    if unsafe { CredDeleteW(target.as_ptr(), GENERIC, 0) } != 0 || unsafe { GetLastError() } == NOT_FOUND { Ok(()) }
    else { Err(unavailable()) }
}
