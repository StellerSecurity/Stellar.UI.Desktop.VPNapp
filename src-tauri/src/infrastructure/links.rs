use stellar_core::domain::AppError;

/// Fixed URL allowlist. No arbitrary shell or renderer-provided command is exposed.
pub fn open(url: &str) -> Result<(), AppError> {
    const ALLOWED: &[&str] = &["https://stellarvpn.org/stellar-relay", "https://stellarvpn.org/privacy-policy", "https://stellarvpn.org/terms-and-conditions"];
    if !ALLOWED.contains(&url) { return Err(AppError::new("invalid_link", "This link is not allowed")); }
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("/usr/bin/open").arg("--").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("rundll32.exe").arg("url.dll,FileProtocolHandler").arg(url).spawn();
    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|_| AppError::new("open_link_failed", "The browser could not be opened"))
}
