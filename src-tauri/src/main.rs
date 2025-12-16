#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};

use tauri::{Emitter, Manager, State};

/// Holds the OpenVPN process and the last known status.
struct VpnInner {
    process: Option<Child>,
    status: String, // "disconnected" | "connecting" | "connected" | "error: ..."
}

/// Shared VPN state between commands and background threads.
#[derive(Clone)]
struct VpnState {
    inner: Arc<Mutex<VpnInner>>,
}

impl VpnState {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(VpnInner {
                process: None,
                status: "disconnected".to_string(),
            })),
        }
    }
}

// Hardcoded OpenVPN binary path per OS, so the user does not need to set env vars.
#[cfg(target_os = "windows")]
const OPENVPN_PATH: &str = "openvpn.exe";

#[cfg(target_os = "linux")]
const OPENVPN_PATH: &str = "/usr/sbin/openvpn";

#[cfg(target_os = "macos")]
const OPENVPN_PATH: &str = "openvpn";

/// Returns the last known VPN status.
#[tauri::command]
fn vpn_status(state: State<'_, VpnState>) -> String {
    let guard = state.inner.lock().unwrap();
    guard.status.clone()
}

/// Stops the OpenVPN process (disconnects the VPN).
#[tauri::command]
fn vpn_disconnect(state: State<'_, VpnState>, app: tauri::AppHandle) -> Result<(), String> {
    println!("[VPN] vpn_disconnect called");

    let mut guard = state.inner.lock().unwrap();

    if let Some(mut child) = guard.process.take() {
        if let Err(e) = child.kill() {
            eprintln!("[VPN] Failed to kill OpenVPN: {e}");
            return Err(format!("Failed to kill OpenVPN: {e}"));
        }
    }

    guard.status = "disconnected".to_string();
    let _ = app.emit("vpn-status", guard.status.clone()).ok();

    Ok(())
}

/// Starts OpenVPN with the given .ovpn config path.
#[tauri::command]
fn vpn_connect(
    window: tauri::Window,
    state: State<'_, VpnState>,
    config_path: String,
) -> Result<(), String> {
    println!("[VPN] vpn_connect called with config_path = {config_path}");

    // Prevent double-connect.
    {
        let mut guard = state.inner.lock().unwrap();
        if guard.process.is_some() {
            println!("[VPN] vpn_connect aborted: VPN already running");
            return Err("VPN already running".into());
        }
        guard.status = "connecting".to_string();
    }

    let app = window.app_handle();
    let state_arc = state.inner.clone();

    // Use the OS-specific hardcoded binary path.
    let openvpn_path = OPENVPN_PATH.to_string();
    println!("[VPN] Using OpenVPN binary at: {openvpn_path}");

    let mut cmd = Command::new(openvpn_path);
    cmd.arg("--config").arg(&config_path);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("Failed to start OpenVPN: {e}");
            eprintln!("[VPN] {msg}");
            {
                let mut guard = state_arc.lock().unwrap();
                guard.status = format!("error: {msg}");
            }
            let _ = app.emit("vpn-status", format!("error: {msg}")).ok();
            return Err(msg);
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    {
        let mut guard = state_arc.lock().unwrap();
        guard.process = Some(child);
        guard.status = "connecting".to_string();
    }
    let _ = app.emit("vpn-status", "connecting").ok();

    // Handle stdout: logs and "connected" detection.
    if let Some(out) = stdout {
        let app_clone = app.clone();
        let state_clone = state_arc.clone();
        std::thread::spawn(move || {
            println!("[VPN] stdout reader thread started");
            let reader = BufReader::new(out);

            for line in reader.lines().flatten() {
                let _ = app_clone.emit("vpn-log", line.clone()).ok();

                if line.contains("Initialization Sequence Completed") {
                    if let Ok(mut g) = state_clone.lock() {
                        g.status = "connected".to_string();
                    }
                    let _ = app_clone.emit("vpn-status", "connected");
                }
            }

            if let Ok(mut g) = state_clone.lock() {
                g.status = "disconnected".to_string();
            }
            let _ = app_clone.emit("vpn-status", "disconnected");
            println!("[VPN] stdout finished, marked as disconnected");
        });
    }

// Handle stderr as error logs.
if let Some(err) = stderr {
    let app_clone = app.clone();
    std::thread::spawn(move || {
        println!("[VPN] stderr reader thread started");
        let reader = BufReader::new(err);
        for line in reader.lines().flatten() {
            println!("[VPN-ERR] {line}");
            let _ = app_clone.emit("vpn-log", format!("[err] {line}"));
        }
    });
}


    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(VpnState::new())
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            vpn_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
