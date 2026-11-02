//! Windows updates use a signed NSIS installer, not in-place executable swapping.
use super::trust;
use std::{fs::{self, OpenOptions, File}, io::{Read, Write}, path::{Path, PathBuf}, sync::{Arc, atomic::{AtomicBool, Ordering}}};
use std::os::windows::fs::{OpenOptionsExt, MetadataExt};
use stellar_core::domain::AppError;
const REPARSE: u32 = 0x400;
pub struct Workspace { pub path: PathBuf, pub launched: bool, directory: Option<File>, _parents: Vec<File> }
impl Workspace {
    pub fn new(directory: &Path) -> Result<Self, AppError> {
        let meta = fs::symlink_metadata(directory).map_err(|_| trust::failure())?;
        if !meta.is_dir() || meta.file_attributes() & REPARSE != 0 { return Err(trust::failure()); }
        if !directory.is_absolute() { return Err(trust::failure()); }
        // Pin every ancestor name against rename/junction substitution while
        // verifying and launching the installer by its path.
        let mut parents = Vec::new();
        for parent in directory.ancestors().collect::<Vec<_>>().into_iter().rev() {
            let file = OpenOptions::new().read(true).share_mode(3).custom_flags(0x02000000 | 0x00200000).open(parent).map_err(|_| trust::failure())?;
            let meta = file.metadata().map_err(|_| trust::failure())?;
            if !meta.is_dir() || meta.file_attributes() & REPARSE != 0 { return Err(trust::failure()); }
            parents.push(file);
        }
        for attempt in 0..32 {
            let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|_| trust::failure())?.as_nanos();
            let path = directory.join(format!("windows-update-{}-{nonce}-{attempt}", std::process::id()));
            match fs::create_dir(&path) {
                Ok(()) => {
                    let guard = OpenOptions::new().read(true).share_mode(1).custom_flags(0x02000000 | 0x00200000).open(&path).map_err(|_| trust::failure())?;
                    return Ok(Self { path, launched: false, directory: Some(guard), _parents: parents });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(_) => return Err(trust::failure()),
            }
        }
        Err(trust::failure())
    }
    pub fn package(&self) -> PathBuf { self.path.join("Stellar-VPN-setup.exe") }
}
impl Drop for Workspace {
    fn drop(&mut self) {
        if !self.launched {
            let _ = fs::remove_file(self.package());
            drop(self.directory.take());
            let _ = fs::remove_dir(&self.path);
        }
    }
}
pub fn fetch_manifest(cancel: Arc<AtomicBool>) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    crate::infrastructure::windows::https(trust::FEED, trust::MAX_MANIFEST, |chunk| {
        if cancel.load(Ordering::SeqCst) { return Err(trust::failure()); }
        bytes.extend_from_slice(chunk); Ok(())
    })?;
    Ok(bytes)
}
pub fn download(directory: &Path, candidate: &trust::Candidate, cancel: Arc<AtomicBool>, mut progress: impl FnMut(usize)) -> Result<Workspace, AppError> {
    let workspace = Workspace::new(directory)?;
    let mut file = OpenOptions::new().write(true).create_new(true).share_mode(0).custom_flags(0x00200000).open(workspace.package()).map_err(|_| trust::failure())?;
    let key = trust::public_key()?; let signature = trust::signature(&candidate.signature)?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?; let mut count = 0;
    crate::infrastructure::windows::https(&candidate.url, trust::MAX_PACKAGE, |chunk| {
        if cancel.load(Ordering::SeqCst) { return Err(trust::failure()); }
        file.write_all(chunk).map_err(|_| trust::failure())?; verifier.update(chunk); count += chunk.len(); progress(count); Ok(())
    })?;
    if count == 0 { return Err(trust::failure()); }
    verifier.finalize().map_err(|_| trust::failure())?; trust::signed_version(&signature, &candidate.version)?;
    file.sync_all().map_err(|_| trust::failure())?; Ok(workspace)
}
pub fn verified_lock(workspace: &Workspace, candidate: &trust::Candidate, cancel: Arc<AtomicBool>) -> Result<File, AppError> {
    let mut file = OpenOptions::new().read(true).share_mode(1).custom_flags(0x00200000).open(workspace.package()).map_err(|_| trust::failure())?;
    let meta = file.metadata().map_err(|_| trust::failure())?;
    if !meta.is_file() || meta.file_attributes() & REPARSE != 0 || meta.len() == 0 || meta.len() > trust::MAX_PACKAGE as u64 { return Err(trust::failure()); }
    let key = trust::public_key()?; let signature = trust::signature(&candidate.signature)?;
    let mut verifier = key.verify_stream(&signature).map_err(|_| trust::failure())?; let mut buffer = [0; 32768];
    loop { if cancel.load(Ordering::SeqCst) { return Err(trust::failure()); } let n = file.read(&mut buffer).map_err(|_| trust::failure())?; if n == 0 { break; } verifier.update(&buffer[..n]); }
    verifier.finalize().map_err(|_| trust::failure())?; trust::signed_version(&signature, &candidate.version)?;
    // Caller retains this no-write/no-delete handle through Windows process launch.
    Ok(file)
}
