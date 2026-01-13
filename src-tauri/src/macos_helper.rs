// src-tauri/src/macos_helper.rs
#![cfg(target_os = "macos")]

use std::path::Path;
use tokio::process::Command;

/// True hvis processen kører som root.
pub fn is_root() -> bool {
  unsafe { libc::geteuid() == 0 }
}

/// Bygger en Command der starter OpenVPN.
/// Lige nu: root => direkte openvpn, ikke-root => sudo -n openvpn (fail fast).
/// (Du kan senere skifte dette til at snakke med din privileged helper.)
pub fn openvpn_command(openvpn_bin: &Path) -> Command {
  if is_root() {
    Command::new(openvpn_bin)
  } else {
    let mut c = Command::new("sudo");
    c.arg("-n").arg(openvpn_bin);
    c
  }
}
