use stellar_core::domain::AppError;

fn allowed(url: &str) -> bool {
    const ALLOWED: &[&str] = &["https://stellarvpn.org/register", "https://stellarvpn.org/stellar-relay", "https://stellarvpn.org/privacy-policy", "https://stellarvpn.org/terms-and-conditions",
        "https://stellarsecurity.com/stellar-notes", "https://stellarsecurity.com/stellar-phone", "https://stellaresim.com/", "https://stellarsecret.io/", "https://stellarsecurity.com/stellar-antivirus", "https://id.stellarsecurity.com/auth/forgot-password"];
    ALLOWED.contains(&url)
}
/// Fixed URL allowlist. No arbitrary shell or renderer-provided command is exposed.
pub fn open(url: &str) -> Result<(), AppError> {
    if !allowed(url) { return Err(AppError::new("invalid_link", "This link is not allowed")); }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg("--").arg(url).spawn();
    #[cfg(target_os = "windows")]
    {
        use std::ffi::c_void;
        #[link(name = "Shell32")]
        unsafe extern "system" {
            fn ShellExecuteW(window: *mut c_void, operation: *const u16, file: *const u16,
                parameters: *const u16, directory: *const u16, show: i32) -> isize;
        }
        let operation: Vec<u16> = "open".encode_utf16().chain(Some(0)).collect();
        let target: Vec<u16> = url.encode_utf16().chain(Some(0)).collect();
        // Native URL dispatch; no executable or DLL lookup through PATH/CWD.
        let status = unsafe { ShellExecuteW(std::ptr::null_mut(), operation.as_ptr(), target.as_ptr(),
            std::ptr::null(), std::ptr::null(), 1) };
        return if status > 32 { Ok(()) } else { Err(AppError::new("open_link_failed", "The browser could not be opened")) };
    }
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("/usr/bin/xdg-open").arg(url).spawn();
    #[cfg(not(target_os = "windows"))]
    result.map(|_| ()).map_err(|_| AppError::new("open_link_failed", "The browser could not be opened"))
}
#[cfg(test)]
mod link_tests {
    use super::allowed;
    #[test] fn anonymous_registration_only_allows_the_exact_official_page() {
        assert!(allowed("https://stellarvpn.org/register"));
        for url in ["http://stellarvpn.org/register", "https://stellarvpn.org.evil.test/register", "https://stellarvpn.org/register?redirect=https://evil.test", "https://stellarvpn.org/register/../admin"] { assert!(!allowed(url)); }
    }
    #[test] fn recovery_only_allows_the_exact_official_page() {
        assert!(allowed("https://id.stellarsecurity.com/auth/forgot-password"));
        for url in ["http://id.stellarsecurity.com/auth/forgot-password", "https://id.stellarsecurity.com.evil.test/auth/forgot-password", "https://id.stellarsecurity.com/auth/forgot-password?email=test@example.com", "https://id.stellarsecurity.com/auth/login"] { assert!(!allowed(url)); }
    }
    #[test] fn only_the_exact_public_product_pages_are_allowed() {
        for url in ["https://stellarsecurity.com/stellar-notes", "https://stellarsecurity.com/stellar-phone", "https://stellaresim.com/", "https://stellarsecret.io/", "https://stellarsecurity.com/stellar-antivirus"] { assert!(allowed(url)); }
        for url in ["https://stellarsecurity.com/", "https://stellarsecurity.com/stellar-notes?redirect=https://evil.test", "https://stellarsecurity.com.evil.test/stellar-phone", "javascript:alert(1)", "file:///tmp/test", "https://evil.test", "--help"] { assert!(!allowed(url)); }
    }
}
