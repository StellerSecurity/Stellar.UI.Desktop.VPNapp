// src-tauri/build.rs
use std::{env, fs, path::PathBuf, process::Command};

fn main() {
    // ✅ REQUIRED: otherwise tauri::generate_context! can panic (capabilities not found)
    tauri_build::build();

    // Re-run if helper source changes
    println!("cargo:rerun-if-changed=bin/stellar-vpn-helper-macos.rs");
    println!("cargo:rerun-if-changed=src/macos_installer.rs");
    println!("cargo:rerun-if-changed=src/macos_helper.rs");

    // Only do macOS helper build/copy on macOS
    if env::var("CARGO_CFG_TARGET_OS").ok().as_deref() != Some("macos") {
        return;
    }

    // Prevent recursion if this build.rs triggers cargo itself
    if env::var("STELLAR_HELPER_BUILDING").ok().as_deref() == Some("1") {
        return;
    }

    // We want a dev-time binary at: src-tauri/bin/stellar-vpn-helper-macos
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()); // src-tauri
    let out_path = manifest_dir.join("bin").join("stellar-vpn-helper-macos");

    if out_path.exists() {
        return;
    }

    // Build the helper binary (the one with required-features = ["macos-build"])
    // We build the current package and binary explicitly.
    let status = Command::new("cargo")
        .current_dir(&manifest_dir)
        .env("STELLAR_HELPER_BUILDING", "1")
        .args([
            "build",
            "--bin",
            "stellar-vpn-helper-macos",
            "--release",
            "--features",
            "macos-build",
        ])
        .status();

    if !matches!(status, Ok(s) if s.success()) {
        // If helper build fails, don't hard-fail the whole build here.
        // The app can still compile, but installer will fail at runtime.
        return;
    }

    // The produced binary ends up in src-tauri/target/release/stellar-vpn-helper-macos
    let candidate = manifest_dir
        .join("target")
        .join("release")
        .join("stellar-vpn-helper-macos");

    if !candidate.exists() {
        return;
    }

    let _ = fs::create_dir_all(out_path.parent().unwrap());
    let _ = fs::copy(&candidate, &out_path);

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&out_path, fs::Permissions::from_mode(0o755));
    }
}
