use super::{process, trust::{self, Candidate, failure}};
use std::{ffi::CString, fs, os::unix::{ffi::OsStrExt, fs::PermissionsExt}, path::{Path, PathBuf}, process::Command, sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}}};
use stellar_core::domain::AppError;
static NEXT: AtomicU64 = AtomicU64::new(0);

pub struct Workspace(pub PathBuf);
impl Workspace {
    pub fn new(parent: &Path) -> Result<Self, AppError> {
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| failure())?.as_nanos();
        let path = parent.join(format!(".stellar-ota-{}-{stamp}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::SeqCst)));
        fs::DirBuilder::new().mode(0o700).create(&path).map_err(|_| AppError::new("update_permission", "This app location is not writable. No update was installed."))?;
        Ok(Self(path))
    }
}
use std::os::unix::fs::DirBuilderExt;
impl Drop for Workspace { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }

pub fn bundle() -> Result<PathBuf, AppError> {
    let executable = tauri::utils::platform::current_exe().map_err(|_| failure())?;
    let bundle = executable.parent().and_then(Path::parent).and_then(Path::parent).ok_or_else(failure)?;
    if bundle.file_name().and_then(|s| s.to_str()) != Some("Stellar VPN.app") || fs::symlink_metadata(bundle).map_err(|_| failure())?.file_type().is_symlink() { return Err(failure()); }
    Ok(bundle.to_path_buf())
}
fn text(command: Command, stderr: bool, cancel: Arc<AtomicBool>) -> Result<String, AppError> {
    String::from_utf8(process::capture(command, stderr, 4 * 1024 * 1024, 30, cancel)?).map_err(|_| failure())
}
fn plist(bundle: &Path, key: &str, cancel: Arc<AtomicBool>) -> Result<String, AppError> {
    let mut command = Command::new("/usr/libexec/PlistBuddy");
    command.arg("-c").arg(format!("Print :{key}")).arg(bundle.join("Contents/Info.plist"));
    Ok(text(command, false, cancel)?.trim().to_owned())
}
pub fn replace(package: &Path, candidate: &Candidate, cancel: Arc<AtomicBool>, before_swap: impl FnOnce() -> Result<(), AppError>) -> Result<(), AppError> {
    let current = bundle()?;
    let workspace = Workspace::new(current.parent().ok_or_else(failure)?)?;
    let mut list = Command::new("/usr/bin/tar"); list.arg("-tzf").arg(package);
    let names = text(list, false, cancel.clone())?;
    let mut list = Command::new("/usr/bin/tar"); list.arg("-tvzf").arg(package);
    let types = text(list, false, cancel.clone())?;
    trust::archive_paths(&names, &types)?;
    let mut extract = Command::new("/usr/bin/tar");
    extract.arg("-xzf").arg(package).arg("-C").arg(&workspace.0).args(["--no-same-owner", "--no-same-permissions"]);
    process::capture(extract, false, 4096, 90, cancel.clone())?;
    let staged = workspace.0.join("Stellar VPN.app");
    if plist(&staged, "CFBundleIdentifier", cancel.clone())? != trust::PRODUCT
        || plist(&staged, "CFBundleShortVersionString", cancel.clone())? != candidate.version
        || plist(&staged, "CFBundleVersion", cancel.clone())? != candidate.version
        || plist(&staged, "StellarUpdateChannel", cancel.clone())? != trust::CHANNEL { return Err(failure()); }
    let executable = plist(&staged, "CFBundleExecutable", cancel.clone())?;
    if executable.is_empty() || executable.len() > 128 || !executable.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b)) { return Err(failure()); }
    let mut arch = Command::new("/usr/bin/lipo");
    arch.arg(staged.join("Contents/MacOS").join(executable)).arg("-verify_arch").arg(if cfg!(target_arch = "aarch64") { "arm64" } else { "x86_64" });
    process::capture(arch, false, 4096, 15, cancel.clone())?;
    // The artifact needs both the pinned OTA signature AND the current app's
    // certificate-backed code identity. Ad-hoc/identifier-only DRs are refused.
    let mut identity = Command::new("/usr/bin/codesign"); identity.args(["-d", "-r-"]).arg(&current);
    let identity = text(identity, true, cancel.clone())?;
    let requirement = identity.lines().find_map(|s| s.strip_prefix("designated => ")).ok_or_else(failure)?;
    if !requirement.contains("certificate ") || !requirement.contains(&format!("identifier \"{}\"", trust::PRODUCT)) { return Err(failure()); }
    let mut verify = Command::new("/usr/bin/codesign");
    fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)).map_err(|_| failure())?;
    verify.args(["--verify", "--deep", "--strict", "--all-architectures", "-R"]).arg(requirement).arg(&staged);
    process::capture(verify, false, 4096, 60, cancel.clone())?;
    if cancel.load(Ordering::SeqCst) { return Err(failure()); }
    before_swap()?;
    // No delete-then-copy and no elevated fallback. Both paths are on the same
    // volume. Failure leaves the installed bundle in place.
    let from = CString::new(staged.as_os_str().as_bytes()).map_err(|_| failure())?;
    let to = CString::new(current.as_os_str().as_bytes()).map_err(|_| failure())?;
    unsafe extern "C" { fn renamex_np(from: *const i8, to: *const i8, flags: u32) -> i32; }
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 2) } != 0 { return Err(AppError::new("update_permission", "The app could not be replaced atomically. Nothing was installed.")); }
    // The old bundle now lives in this transaction directory. Keep it for
    // recovery instead of deleting the only rollback copy before relaunch.
    std::mem::forget(workspace);
    Ok(())
}
