//! Linux updates use the OTA-signed Debian package and the system package manager.
//! The server is untrusted: bytes are verified with the pinned app key before
//! metadata inspection and again immediately before administrator approval.
use super::{process, trust};
use stellar_core::domain::AppError;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::{fd::AsRawFd, unix::fs::{DirBuilderExt, OpenOptionsExt}},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Arc, atomic::{AtomicBool, Ordering}},
};

const O_NOFOLLOW: i32 = 0x20000;

pub struct Workspace { path: PathBuf }
impl Workspace {
    pub fn new(parent: &Path) -> Result<Self, AppError> {
        let parent_meta = fs::symlink_metadata(parent).map_err(|_| trust::failure())?;
        if !parent_meta.is_dir() || parent_meta.file_type().is_symlink() || !parent.is_absolute() { return Err(trust::failure()); }
        for attempt in 0..32 {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| trust::failure())?.as_nanos();
            let path = parent.join(format!("linux-update-{}-{nonce}-{attempt}", std::process::id()));
            match fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => return Ok(Self { path }),
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(trust::failure()),
            }
        }
        Err(trust::failure())
    }
    pub fn package(&self) -> PathBuf { self.path.join("Stellar VPN.deb") }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        let _ = fs::remove_file(self.package());
        let _ = fs::remove_dir(&self.path);
    }
}

pub fn fetch_manifest(cancel: Arc<AtomicBool>) -> Result<Vec<u8>, AppError> {
    let mut last = Err(trust::unavailable());
    for attempt in 0..2 {
        last = process::capture(process::curl(trust::FEED, trust::MAX_MANIFEST, 10), false, trust::MAX_MANIFEST, 12, cancel.clone());
        if last.is_ok() || cancel.load(Ordering::SeqCst) { break; }
        if attempt == 0 { std::thread::sleep(std::time::Duration::from_millis(400)); }
    }
    last
}

pub fn download(directory: &Path, candidate: &trust::Candidate, cancel: Arc<AtomicBool>, mut progress: impl FnMut(usize)) -> Result<Workspace, AppError> {
    let workspace = Workspace::new(directory)?;
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(O_NOFOLLOW).open(workspace.package()).map_err(|_| trust::failure())?;
    let key = trust::public_key()?;
    let signature = trust::signature(&candidate.signature)?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?;
    let mut count = 0usize;
    process::run(process::curl(&candidate.url, trust::MAX_PACKAGE, 120), false, trust::MAX_PACKAGE, 125, cancel.clone(), |chunk| {
        file.write_all(chunk).map_err(|_| trust::failure())?;
        verifier.update(chunk);
        count = count.checked_add(chunk.len()).ok_or_else(trust::failure)?;
        progress(count);
        Ok(())
    })?;
    if count == 0 { return Err(trust::failure()); }
    verifier.finalize().map_err(|_| trust::failure())?;
    trust::signed_version(&signature, &candidate.version)?;
    file.sync_all().map_err(|_| trust::failure())?;
    verify_metadata(&workspace.package(), &candidate.version)?;
    Ok(workspace)
}

fn verified_file(workspace: &Workspace, candidate: &trust::Candidate, cancel: Arc<AtomicBool>) -> Result<File, AppError> {
    let path = workspace.package();
    let meta = fs::symlink_metadata(&path).map_err(|_| trust::failure())?;
    if !meta.is_file() || meta.file_type().is_symlink() || meta.len() == 0 || meta.len() > trust::MAX_PACKAGE as u64 { return Err(trust::failure()); }
    let mut file = OpenOptions::new().read(true).custom_flags(O_NOFOLLOW).open(&path).map_err(|_| trust::failure())?;
    let key = trust::public_key()?;
    let signature = trust::signature(&candidate.signature)?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?;
    let mut buffer = [0; 32 * 1024];
    loop {
        if cancel.load(Ordering::SeqCst) { return Err(trust::failure()); }
        let read = file.read(&mut buffer).map_err(|_| trust::failure())?;
        if read == 0 { break; }
        verifier.update(&buffer[..read]);
    }
    verifier.finalize().map_err(|_| trust::failure())?;
    trust::signed_version(&signature, &candidate.version)?;
    verify_metadata(&locked_path(&file), &candidate.version)?;
    Ok(file)
}

fn locked_path(file: &File) -> PathBuf {
    PathBuf::from(format!("/proc/{}/fd/{}", std::process::id(), file.as_raw_fd()))
}

fn verify_metadata(path: &Path, version: &str) -> Result<(), AppError> {
    let output = Command::new("/usr/bin/dpkg-deb")
        .env_clear().env("LC_ALL", "C")
        .args(["--field"]).arg(path).args(["Package", "Version", "Architecture"])
        .stdin(Stdio::null()).stderr(Stdio::null()).output().map_err(|_| trust::failure())?;
    if !output.status.success() || output.stdout.len() > 1024 { return Err(trust::failure()); }
    let fields = std::str::from_utf8(&output.stdout).map_err(|_| trust::failure())?;
    let expected = format!("Package: stellar-vpn\nVersion: {version}\nArchitecture: amd64\n");
    if fields != expected { return Err(trust::failure()); }
    Ok(())
}

pub fn install(workspace: &mut Workspace, candidate: &trust::Candidate, cancel: Arc<AtomicBool>) -> Result<(), AppError> {
    let locked = verified_file(workspace, candidate, cancel)?;
    let package = locked_path(&locked);
    let status = Command::new("/usr/bin/pkexec")
        .env_clear()
        .arg("/usr/bin/dpkg").args(["--install"]).arg(package)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .status().map_err(|_| AppError::new("update_permission", "Administrator approval is required to install this update."))?;
    drop(locked);
    if !status.success() { return Err(AppError::new("update_permission", "The Linux package manager did not install the update.")); }
    Ok(())
}
