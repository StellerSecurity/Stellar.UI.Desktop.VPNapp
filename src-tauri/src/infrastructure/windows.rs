//! First-party, statically linked Windows SDK bridge. No shell or secret arguments.
use stellar_core::domain::AppError;
use std::path::Path;
unsafe extern "C" {
    fn stellar_windows_exchange(input: *const u8, length: usize, output: *mut u8, capacity: usize, timeout: u32) -> i32;
    fn stellar_windows_autostart(enabled: i32) -> i32;
    fn stellar_windows_network_stamp(output: *mut u64) -> i32;
    fn stellar_windows_https(url: *const u16, maximum: usize, consume: extern "C" fn(*const u8, usize, *mut std::ffi::c_void) -> i32, context: *mut std::ffi::c_void) -> i32;
    fn stellar_windows_launch_installer(path: *const u16) -> i32;
    fn stellar_windows_repair() -> i32;
    fn stellar_windows_instance() -> isize;
    fn stellar_windows_close_instance(instance: isize);
    fn stellar_windows_legacy_read(path: *const u16, output: *mut u8, capacity: usize) -> i32;
    fn stellar_windows_legacy_replace(path: *const u16, old: *const u8, old_size: usize, replacement: *const u8, size: usize) -> i32;
}
fn failure() -> AppError { AppError::new("windows_integration_unavailable", "The Windows system integration is unavailable.") }
pub fn exchange(mut request: Vec<u8>, milliseconds: u32) -> Result<Vec<u8>, AppError> {
    let mut output = [0u8; 256];
    let count = unsafe { stellar_windows_exchange(request.as_ptr(), request.len(), output.as_mut_ptr(), output.len(), milliseconds) };
    for byte in &mut request { unsafe { std::ptr::write_volatile(byte, 0) }; }
    if count <= 0 || count as usize > output.len() { return Err(failure()); }
    Ok(output[..count as usize].to_vec())
}
pub fn autostart(enabled: bool) -> Result<(), AppError> { if unsafe { stellar_windows_autostart(i32::from(enabled)) } == 1 { Ok(()) } else { Err(failure()) } }
pub fn network_stamp() -> Result<u64, AppError> { let mut stamp = 0; if unsafe { stellar_windows_network_stamp(&mut stamp) } == 1 { Ok(stamp) } else { Err(failure()) } }
pub fn https(url: &str, max: usize, mut consume: impl FnMut(&[u8]) -> Result<(), AppError>) -> Result<(), AppError> {
    struct Callback<'a> { action: &'a mut dyn FnMut(&[u8]) -> Result<(), AppError>, failed: bool }
    extern "C" fn callback(bytes: *const u8, size: usize, raw: *mut std::ffi::c_void) -> i32 {
        if raw.is_null() || bytes.is_null() || size > 32768 { return 0; }
        let context = unsafe { &mut *raw.cast::<Callback<'_>>() };
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (context.action)(unsafe { std::slice::from_raw_parts(bytes, size) })));
        context.failed = !matches!(result, Ok(Ok(()))); i32::from(!context.failed)
    }
    if url.contains('\0') { return Err(failure()); }
    let url: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
    let mut context = Callback { action: &mut consume, failed: false };
    let result = unsafe { stellar_windows_https(url.as_ptr(), max, callback, (&mut context as *mut Callback<'_>).cast()) };
    if result == 1 && !context.failed { Ok(()) } else { Err(failure()) }
}
pub fn launch_installer(path: &Path) -> Result<(), AppError> {
    let path = wide(path)?;
    if unsafe { stellar_windows_launch_installer(path.as_ptr()) } == 1 { Ok(()) } else { Err(failure()) }
}
pub fn repair() -> Result<(), AppError> { if unsafe { stellar_windows_repair() } == 1 { Ok(()) } else { Err(failure()) } }
pub fn instance() -> Result<Option<isize>, AppError> {
    match unsafe { stellar_windows_instance() } { -1 => Err(failure()), 0 => Ok(None), handle => Ok(Some(handle)) }
}
pub fn close_instance(handle: isize) { unsafe { stellar_windows_close_instance(handle) }; }
fn wide(path: &Path) -> Result<Vec<u16>, AppError> {
    use std::os::windows::ffi::OsStrExt;
    let mut value: Vec<u16> = path.as_os_str().encode_wide().collect();
    if value.contains(&0) { return Err(failure()); } value.push(0); Ok(value)
}
pub fn legacy_read(path: &Path) -> Result<Option<String>, AppError> {
    let path = wide(path)?; let mut bytes = vec![0u8; 65536];
    let count = unsafe { stellar_windows_legacy_read(path.as_ptr(), bytes.as_mut_ptr(), bytes.len()) };
    let result = if count == 0 { Ok(None) } else if count < 0 || count as usize > bytes.len() { Err(failure()) }
        else { std::str::from_utf8(&bytes[..count as usize]).map(|v| Some(v.to_owned())).map_err(|_| failure()) };
    for byte in &mut bytes { unsafe { std::ptr::write_volatile(byte, 0) }; } result
}
pub fn legacy_replace(path: &Path, old: &str, replacement: &str) -> Result<(), AppError> {
    let path = wide(path)?;
    if unsafe { stellar_windows_legacy_replace(path.as_ptr(), old.as_ptr(), old.len(), replacement.as_ptr(), replacement.len()) } == 1 { Ok(()) } else { Err(failure()) }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_boundary_rejects_invalid_requests_before_network_or_elevation() {
        assert!(exchange(vec![0], 40001).is_err());
        assert!(https("https://example.invalid/vpn/desktop-v2/file", 1024, |_| panic!("must not connect")).is_err());
        assert!(https("https://desktopreleasesassetsprod.stellarsecurity.com/other/file", 1024, |_| panic!("must not connect")).is_err());
        assert!(launch_installer(Path::new("synthetic\0installer.exe")).is_err());
        assert!(legacy_read(Path::new("synthetic\0.stellar-vpn.dat")).is_err());
        assert!(legacy_replace(Path::new("synthetic\0.stellar-vpn.dat"), "old", "new").is_err());
    }
    #[test]
    fn native_instance_lock_releases_without_registering_a_service() {
        struct Lock(isize);
        impl Drop for Lock { fn drop(&mut self) { close_instance(self.0); } }
        let first = Lock(instance().unwrap().expect("first native lock"));
        assert!(instance().unwrap().is_none());
        drop(first);
        let second = Lock(instance().unwrap().expect("released native lock"));
        drop(second);
    }
}
