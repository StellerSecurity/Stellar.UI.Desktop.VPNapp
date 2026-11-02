//! The update server is an untrusted distributor, not a signing authority.
use minisign_verify::{PublicKey, Signature};
use serde::Deserialize;
use std::{collections::HashMap, path::Path};
use stellar_core::domain::AppError;

pub const CHANNEL: &str = "desktop-v2";
pub const FEED: &str = "https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/latest.json";
#[cfg(target_os = "macos")]
pub const PRODUCT: &str = "org.stellarsecurity.vpn.desktop";
// Original VPN Minisign public key, from the tracked legacy configuration.
// Never load this trust root from the server, settings, environment or IPC.
pub const PUBLIC_KEY: &str = "RWQUGfAK3zjGYaQPFF9NwbJtSiBwmbRGcPwjdnrkWfJwc/RDrV70avz2";
pub const MAX_MANIFEST: usize = 64 * 1024;
pub const MAX_SIGNATURE: usize = 4096;
pub const MAX_PACKAGE: usize = 512 * 1024 * 1024;

pub fn failure() -> AppError { AppError::new("update_rejected", "The update could not be verified. Nothing was installed.") }
pub fn unavailable() -> AppError { AppError::new("update_unavailable", "The update service is unavailable. Try again later.") }

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Version(pub [u32; 3]);
impl Version {
    // Stable releases only. Reject prerelease/build aliases instead of inventing
    // an incomplete SemVer ordering at this security boundary.
    pub fn parse(value: &str) -> Result<Self, AppError> {
        let parts: Vec<_> = value.split('.').collect();
        if parts.len() != 3 { return Err(failure()); }
        let mut numbers = [0; 3];
        for (index, part) in parts.iter().enumerate() {
            if part.is_empty() || part.len() > 10 || !part.bytes().all(|b| b.is_ascii_digit()) || (part.len() > 1 && part.starts_with('0')) { return Err(failure()); }
            numbers[index] = part.parse().map_err(|_| failure())?;
        }
        Ok(Self(numbers))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: String,
    #[serde(default)] notes: Option<String>,
    #[serde(default)] pub_date: Option<String>,
    platforms: HashMap<String, Platform>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Platform { url: String, signature: String }
#[derive(Clone, Debug)]
pub struct Candidate { pub version: String, pub notes: String, pub url: String, pub signature: String }

pub fn platform() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) { "darwin-aarch64" }
    else if cfg!(all(target_os = "macos", target_arch = "x86_64")) { "darwin-x86_64" }
    else if cfg!(all(target_os = "windows", target_arch = "x86_64")) { "windows-x86_64" }
    else if cfg!(all(target_os = "windows", target_arch = "aarch64")) { "windows-aarch64" }
    else { "unsupported" }
}
pub fn valid_url(raw: &str, version: &str) -> bool {
    let Ok(url) = tauri::Url::parse(raw) else { return false; };
    let prefix = format!("/vpn/{CHANNEL}/{version}/");
    url.scheme() == "https" && url.host_str() == Some("desktopreleasesassetsprod.stellarsecurity.com")
        && url.port().is_none() && url.username().is_empty() && url.password().is_none()
        && url.query().is_none() && url.fragment().is_none()
        && url.path().starts_with(&prefix) && url.path().ends_with(".app.tar.gz")
        && !url.path().contains('%') // encoded spaces are permitted only as %20 below
}
pub fn artifact_url(raw: &str, version: &str) -> bool {
    // URL parser normalizes spaces, so allow only the one necessary encoding.
    let normalized = raw.replace("%20", "_").replace(' ', "_");
    valid_url(&normalized, version) && !raw.contains('\\') && !raw.contains(['\r', '\n'])
}
pub fn artifact_url_for_target(raw: &str, version: &str, target: &str) -> bool {
    if target.starts_with("darwin-") { return matches!(target, "darwin-aarch64" | "darwin-x86_64") && artifact_url(raw, version); }
    if !matches!(target, "windows-x86_64" | "windows-aarch64") || !raw.ends_with("-setup.exe") { return false; }
    // Reuse the exact origin/path/encoding checks without accepting a Mac archive
    // in the Windows slot or a Windows executable in either Mac slot.
    let Some(stem) = raw.strip_suffix("-setup.exe") else { return false; };
    artifact_url(&format!("{stem}.app.tar.gz"), version)
}
pub fn manifest(bytes: &[u8], installed: &str, target: &str) -> Result<Option<Candidate>, AppError> {
    if bytes.is_empty() { return Ok(None); } // HTTP 204 from a dynamic feed.
    if bytes.len() > MAX_MANIFEST { return Err(failure()); }
    let text = std::str::from_utf8(bytes).map_err(|_| failure())?;
    // Reuse Tauri's already installed JSON parser; no new JSON dependency.
    let value = tauri::utils::config::parse::parse_json_value(text, Path::new("update.json")).map_err(|_| failure())?;
    let manifest = Manifest::deserialize(value).map_err(|_| failure())?;
    if manifest.platforms.len() > 16 || manifest.notes.as_ref().is_some_and(|v| v.len() > 8192) || manifest.pub_date.as_ref().is_some_and(|v| v.len() > 64) { return Err(failure()); }
    if Version::parse(&manifest.version)? <= Version::parse(installed)? { return Ok(None); }
    let item = manifest.platforms.get(target).ok_or_else(failure)?;
    if !artifact_url_for_target(&item.url, &manifest.version, target) || item.signature.is_empty() || item.signature.len() > MAX_SIGNATURE { return Err(failure()); }
    Ok(Some(Candidate { version: manifest.version, notes: manifest.notes.unwrap_or_default(), url: item.url.clone(), signature: item.signature.clone() }))
}

pub fn decode_base64(value: &str) -> Result<Vec<u8>, AppError> {
    if value.is_empty() || value.len() > MAX_SIGNATURE || value.len() % 4 != 0 { return Err(failure()); }
    let mut out = Vec::new();
    let total = value.len() / 4;
    for (index, group) in value.as_bytes().chunks_exact(4).enumerate() {
        let mut n = [0u8; 4];
        let mut padding = 0;
        for (i, b) in group.iter().copied().enumerate() {
            n[i] = match b {
                b'A'..=b'Z' => b - b'A', b'a'..=b'z' => b - b'a' + 26,
                b'0'..=b'9' => b - b'0' + 52, b'+' => 62, b'/' => 63,
                b'=' if i >= 2 && index + 1 == total => { padding += 1; 0 }, _ => return Err(failure()),
            };
            if padding > 0 && b != b'=' { return Err(failure()); }
        }
        if padding > 2 || (padding == 2 && n[1] & 15 != 0) || (padding == 1 && n[2] & 3 != 0) { return Err(failure()); }
        out.push(n[0] << 2 | n[1] >> 4);
        if padding < 2 { out.push(n[1] << 4 | n[2] >> 2); }
        if padding == 0 { out.push(n[2] << 6 | n[3]); }
    }
    Ok(out)
}
pub fn signature(value: &str) -> Result<Signature, AppError> {
    if value.len() > MAX_SIGNATURE { return Err(failure()); }
    let decoded;
    let text = if value.starts_with("untrusted comment: ") { value } else {
        decoded = decode_base64(value.trim())?;
        std::str::from_utf8(&decoded).map_err(|_| failure())?
    };
    if text.lines().count() != 4 { return Err(failure()); }
    Signature::decode(text).map_err(|_| failure())
}
pub fn signed_version(signature: &Signature, expected: &str) -> Result<(), AppError> {
    let fields: Vec<_> = signature.trusted_comment().split('\t').filter_map(|s| s.strip_prefix("version:")).collect();
    if fields != [expected] || Version::parse(expected).is_err() { return Err(failure()); }
    Ok(())
}
pub fn public_key() -> Result<PublicKey, AppError> { PublicKey::from_base64(PUBLIC_KEY).map_err(|_| failure()) }
#[cfg(test)]
pub fn verify(bytes: &[u8], candidate: &Candidate, key: &PublicKey) -> Result<(), AppError> {
    let signature = signature(&candidate.signature)?;
    key.verify(bytes, &signature, false).map_err(|_| failure())?;
    // Never treat the so-called trusted comment as trusted before verification.
    signed_version(&signature, &candidate.version)
}
pub fn installation_allowed(connection: &stellar_core::domain::ConnectionSnapshot) -> bool {
    connection.status == stellar_core::domain::ConnectionStatus::Disconnected && !connection.traffic_blocked
}
pub fn completed_version(expected: &str, actual: &str) -> bool {
    Version::parse(expected).is_ok() && Version::parse(actual).is_ok() && expected == actual
}

pub fn archive_paths(names: &str, types: &str) -> Result<(), AppError> {
    let entries: Vec<_> = names.lines().collect();
    if entries.is_empty() || entries.len() > 20_000 || entries.len() != types.lines().count() { return Err(failure()); }
    for name in entries {
        if !(name == "Stellar VPN.app" || name.starts_with("Stellar VPN.app/")) || name.len() > 1024 || name.contains('\\')
            || !name.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
            || name.split('/').any(|p| p == ".." || p == ".") { return Err(failure()); }
    }
    if types.lines().any(|line| !line.starts_with(['-', 'd'])) { return Err(failure()); }
    Ok(())
}
