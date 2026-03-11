// src-tauri/build.rs
use std::env;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=bin/stellar-vpn-helper-macos.rs");
    println!("cargo:rerun-if-changed=src/macos_installer.rs");
    println!("cargo:rerun-if-changed=src/macos_helper.rs");

    // When building only the mac helper, skip tauri_build::build()
    // because tauri_build validates bundle.resources and the helper
    // file does not exist yet at that point.
    if env::var("STELLAR_HELPER_BUILDING").ok().as_deref() == Some("1") {
        return;
    }

    tauri_build::build();
}