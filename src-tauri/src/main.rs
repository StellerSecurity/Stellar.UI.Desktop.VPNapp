// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos_helper;

#[cfg(target_os = "macos")]
mod macos_installer;

use tauri::Wry;
type RT = Wry;

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    path::BaseDirectory,
    tray::{TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WindowEvent,
};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::Mutex,
    time,
};

type SharedState = std::sync::Arc<Mutex<VpnInner>>;

const CONNECT_WATCHDOG_MS: u64 = 10_000;
const TRAY_ID: &str = "stellar-vpn-tray";
const NETWORK_HEALTH_POLL_MS: u64 = 500;
const NETWORK_LOSS_THRESHOLD: u32 = 3;
const RESUME_GAP_SECS: u64 = 15;
const NETWORK_RECOVERY_WAIT_SECS: u64 = 45;
const NETWORK_RECONNECT_RETRIES: u32 = 3;
const NETWORK_RECONNECT_RETRY_DELAY_SECS: u64 = 3;
const POST_CONNECT_MONITOR_COOLDOWN_MS: u64 = 20_000;
const POST_CONNECT_LOSS_GRACE_MS: u64 = 3_000;

const TRAY_ICON_OFFLINE_BYTES: &[u8] = include_bytes!("../icons/tray-offline.png");
const TRAY_ICON_ONLINE_BYTES: &[u8] = include_bytes!("../icons/tray-online.png");

#[cfg(target_os = "linux")]
const LINUX_HELPER_PATH: &str = "/usr/libexec/stellar-vpn/stellar-vpn-helper";

#[cfg(target_os = "macos")]
const MACOS_HELPER_SOCKET: &str = macos_installer::SOCKET_PATH;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UiStatus {
    Disconnected,
    Connecting,
    Connected,
}

impl UiStatus {
    fn as_str(&self) -> &'static str {
        match self {
            UiStatus::Disconnected => "disconnected",
            UiStatus::Connecting => "connecting",
            UiStatus::Connected => "connected",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NetworkPath {
    interface: String,
    gateway: Option<String>,
}

#[derive(Debug)]
struct Session {
    sid: u64,
    stop_tx: tokio::sync::watch::Sender<bool>,
}

#[derive(Debug)]
struct VpnInner {
    status: UiStatus,
    session: Option<Session>,
    kill_switch_enabled: bool,
    disconnect_requested: bool,
    next_sid: u64,
    last_config_path: Option<String>,
    last_config_source: Option<String>,
    last_username: Option<String>,
    last_password: Option<String>,
    last_base_network_path: Option<NetworkPath>,
    network_loss_streak: u32,
    base_network_interrupted: bool,
    auto_reconnect_running: bool,
    connect_request_running: bool,
    last_connected_at_ms: Option<u64>,
}

impl Default for VpnInner {
    fn default() -> Self {
        Self {
            status: UiStatus::Disconnected,
            session: None,
            kill_switch_enabled: false,
            disconnect_requested: false,
            next_sid: 1,
            last_config_path: None,
            last_config_source: None,
            last_username: None,
            last_password: None,
            last_base_network_path: None,
            network_loss_streak: 0,
            base_network_interrupted: false,
            auto_reconnect_running: false,
            connect_request_running: false,
            last_connected_at_ms: None,
        }
    }
}

// ---------------- UI Emits ----------------

fn emit_status(app: &AppHandle<RT>, s: &str) {
    let _ = app.emit("vpn-status", s.to_string());
}

fn emit_log(app: &AppHandle<RT>, line: &str) {
    let _ = app.emit("vpn-log", line.to_string());
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

// ---------------- Tray handles stored in app state ----------------

#[derive(Clone)]
struct TrayHandles {
    connect: MenuItem<RT>,
    reconnect: MenuItem<RT>,
    disconnect: MenuItem<RT>,
}

fn tray_icon_for_status(st: UiStatus) -> Option<Image<'static>> {
    let bytes = match st {
        UiStatus::Connected => TRAY_ICON_ONLINE_BYTES,
        UiStatus::Connecting | UiStatus::Disconnected => TRAY_ICON_OFFLINE_BYTES,
    };
    Image::from_bytes(bytes).ok()
}

#[cfg(target_os = "linux")]
fn tray_temp_dir() -> PathBuf {
    temp_dir().join("tray-icon")
}

fn update_tray_ui_inner(app: &AppHandle<RT>, st: UiStatus) {
    let handles = app.state::<TrayHandles>();

    let can_connect = st == UiStatus::Disconnected;
    let can_disconnect = st != UiStatus::Disconnected;

    let _ = handles.connect.set_enabled(can_connect);
    let _ = handles.reconnect.set_enabled(can_connect);
    let _ = handles.disconnect.set_enabled(can_disconnect);

    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        #[cfg(target_os = "linux")]
        {
            let _ = fs::create_dir_all(tray_temp_dir());
            let _ = tray.set_temp_dir_path(Some(tray_temp_dir()));
        }

        if let Some(img) = tray_icon_for_status(st) {
            let _ = tray.set_icon(Some(img));
        }
    }
}

/// IMPORTANT:
/// Tray updates should run on the main thread, otherwise updates can silently not apply.
fn update_tray_ui(app: &AppHandle<RT>, st: UiStatus) {
    let app_for_call = app.clone();
    let app_for_closure = app.clone();
    let st_copy = st;

    let res = app_for_call.run_on_main_thread(move || {
        update_tray_ui_inner(&app_for_closure, st_copy);
    });

    if res.is_err() {
        update_tray_ui_inner(app, st);
    }
}

// ---------------- Tray helpers ----------------

fn show_main(app: &AppHandle<RT>) {
    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(true);

    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle<RT>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }

    #[cfg(target_os = "macos")]
    let _ = app.set_dock_visibility(false);
}

fn setup_tray(app: &AppHandle<RT>) -> tauri::Result<TrayHandles> {
    let open = MenuItem::with_id(app, "open", "Open Stellar VPN", true, None::<&str>)?;
    let connect = MenuItem::with_id(app, "connect", "Connect", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "Reconnect", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&open, &connect, &reconnect, &disconnect, &quit])?;
    let icon = Image::from_bytes(TRAY_ICON_OFFLINE_BYTES)?;

    #[cfg(target_os = "linux")]
    let builder = {
        let _ = fs::create_dir_all(tray_temp_dir());
        TrayIconBuilder::with_id(TRAY_ID).temp_dir_path(tray_temp_dir())
    };

    #[cfg(not(target_os = "linux"))]
    let builder = TrayIconBuilder::with_id(TRAY_ID);

    builder
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
                show_main(app);
                let _ = app.emit("tray-open", ());
            }
            "connect" => {
                update_tray_ui(app, UiStatus::Connecting);
                let _ = app.emit("tray-connect", ());
            }
            "reconnect" => {
                update_tray_ui(app, UiStatus::Connecting);
                let _ = app.emit("tray-reconnect", ());
            }
            "disconnect" => {
                update_tray_ui(app, UiStatus::Disconnected);
                let _ = app.emit("tray-disconnect", ());
            }
            "quit" => {
                let _ = app.emit("tray-quit", ());
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, e| {
            if let TrayIconEvent::DoubleClick { .. } = e {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(TrayHandles {
        connect,
        reconnect,
        disconnect,
    })
}

// ---------------- Temp/auth/config helpers ----------------

fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("stellar-vpn-desktop")
}

fn ensure_temp_dir() -> Result<(), String> {
    let d = temp_dir();
    fs::create_dir_all(&d).map_err(|e| format!("Failed to create temp dir: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&d, fs::Permissions::from_mode(0o700));
    }

    Ok(())
}

fn write_auth_file(username: &str, password: &str, sid: u64) -> Result<PathBuf, String> {
    ensure_temp_dir()?;
    let p = temp_dir().join(format!("auth-{sid}.txt"));

    let content = format!("{username}\n{password}\n");
    fs::write(&p, content).map_err(|e| format!("Failed to write auth file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&p, fs::Permissions::from_mode(0o600));
    }

    Ok(p)
}

async fn download_to_file(url: &str, sid: u64) -> Result<PathBuf, String> {
    ensure_temp_dir()?;
    let out = temp_dir().join(format!("config-{sid}.ovpn"));

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Failed to download config: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Failed to download config: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("Failed reading config bytes: {e}"))?;

    tokio::fs::write(&out, &bytes)
        .await
        .map_err(|e| format!("Failed writing config file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&out, fs::Permissions::from_mode(0o600));
    }

    Ok(out)
}

fn looks_like_url(s: &str) -> bool {
    s.starts_with("http://") || s.starts_with("https://")
}

async fn prepare_config(config_path: &str, sid: u64) -> Result<PathBuf, String> {
    if looks_like_url(config_path) {
        download_to_file(config_path, sid).await
    } else {
        let p = PathBuf::from(config_path);
        if !p.exists() {
            return Err(format!("Config file not found: {}", p.display()));
        }
        Ok(p)
    }
}

// ---------------- OpenVPN binary resolution ----------------

#[cfg(all(target_os = "linux", target_arch = "x86_64"))]
const OPENVPN_REL: &str = "bin/openvpn-x86_64-unknown-linux-gnu";
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const OPENVPN_REL: &str = "bin/openvpn-x86_64-pc-windows-msvc.exe";
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const OPENVPN_REL: &str = "bin/openvpn-aarch64-apple-darwin";
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const OPENVPN_REL: &str = "bin/openvpn-x86_64-apple-darwin";

#[cfg(not(any(
    all(target_os = "linux", target_arch = "x86_64"),
    all(target_os = "windows", target_arch = "x86_64"),
    all(target_os = "macos", target_arch = "aarch64"),
    all(target_os = "macos", target_arch = "x86_64"),
)))]
const OPENVPN_REL: &str = "openvpn";

fn resolve_openvpn_binary(app: &AppHandle<RT>) -> Result<PathBuf, String> {
    #[cfg(target_os = "linux")]
    {
        let installed = PathBuf::from("/usr/lib/stellar-vpn/openvpn");
        if installed.exists() {
            return Ok(installed);
        }
    }

    if OPENVPN_REL == "openvpn" {
        return Ok(PathBuf::from("openvpn"));
    }

    if let Ok(p) = app.path().resolve(OPENVPN_REL, BaseDirectory::Resource) {
        if p.exists() {
            return Ok(p);
        }
    }

    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(OPENVPN_REL);
    if dev.exists() {
        return Ok(dev);
    }

    Ok(PathBuf::from("openvpn"))
}

// ---------------- Kill switch helper invocations (linux) ----------------

#[cfg(target_os = "linux")]
async fn run_helper_direct(enable: bool, cfg: Option<&str>) -> Result<(), String> {
    let helper = LINUX_HELPER_PATH;
    if !Path::new(helper).exists() {
        return Err(
            "Kill switch helper missing: /usr/libexec/stellar-vpn/stellar-vpn-helper".to_string(),
        );
    }

    let mut cmd = Command::new(helper);
    cmd.arg("killswitch")
        .arg(if enable { "enable" } else { "disable" });

    if enable {
        let c =
            cfg.ok_or_else(|| "config_path is required when enabling kill switch.".to_string())?;
        cmd.arg("--config").arg(c);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to start helper: {e}"))?;

    if out.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Err(format!(
        "Direct helper failed.\n{}\n{}",
        if stdout.trim().is_empty() { "" } else { &stdout },
        if stderr.trim().is_empty() { "" } else { &stderr }
    ))
}

#[cfg(target_os = "linux")]
async fn run_helper_pkexec(enable: bool, cfg: Option<&str>) -> Result<(), String> {
    let helper = LINUX_HELPER_PATH;
    if !Path::new(helper).exists() {
        return Err(
            "Kill switch helper missing: /usr/libexec/stellar-vpn/stellar-vpn-helper".to_string(),
        );
    }

    let mut cmd = Command::new("pkexec");
    cmd.arg(helper)
        .arg("killswitch")
        .arg(if enable { "enable" } else { "disable" });

    if enable {
        let c =
            cfg.ok_or_else(|| "config_path is required when enabling kill switch.".to_string())?;
        cmd.arg("--config").arg(c);
    }

    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Failed to start pkexec: {e}"))?;

    if out.status.success() {
        return Ok(());
    }

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Err(format!(
        "Kill switch helper failed.\n{}\n{}",
        if stdout.trim().is_empty() { "" } else { &stdout },
        if stderr.trim().is_empty() { "" } else { &stderr }
    ))
}

#[cfg(target_os = "linux")]
async fn apply_kill_switch(enable: bool, config_path: Option<&str>) -> Result<(), String> {
    if enable {
        let cfg = config_path
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "config_path is required when enabling kill switch.".to_string())?;

        if !Path::new(cfg).exists() {
            return Err(format!("config_path does not exist: {cfg}"));
        }

        if let Ok(()) = run_helper_direct(true, Some(cfg)).await {
            return Ok(());
        }

        return run_helper_pkexec(true, Some(cfg)).await;
    }

    if let Ok(()) = run_helper_direct(false, None).await {
        return Ok(());
    }
    run_helper_pkexec(false, None).await
}

#[cfg(not(target_os = "linux"))]
async fn apply_kill_switch(_enable: bool, _config_path: Option<&str>) -> Result<(), String> {
    Err("Kill switch requires admin/root on this platform.".to_string())
}

#[cfg(target_os = "linux")]
async fn killswitch_table_exists() -> bool {
    let out = Command::new("nft")
        .args(["list", "table", "inet", "stellarkillswitch"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .await;

    matches!(out, Ok(o) if o.status.success())
}

#[cfg(not(target_os = "linux"))]
async fn killswitch_table_exists() -> bool {
    false
}

#[cfg(target_os = "linux")]
async fn cleanup_killswitch_when_disabled(app: &AppHandle<RT>, state: &SharedState) {
    let ks = { state.lock().await.kill_switch_enabled };
    if ks {
        return;
    }

    let _ = run_helper_direct(false, None).await;

    if killswitch_table_exists().await {
        emit_log(app, "[ui] WARNING: kill switch nft table still exists after disable attempt. Internet may remain blocked.");
    }
}

#[cfg(not(target_os = "linux"))]
async fn cleanup_killswitch_when_disabled(_app: &AppHandle<RT>, _state: &SharedState) {}

// ---------------- Network path helpers ----------------

fn is_vpn_interface(name: &str) -> bool {
    name.starts_with("tun") || name.starts_with("tap") || name.starts_with("utun")
}

fn network_path_label(path: &NetworkPath) -> String {
    match &path.gateway {
        Some(gateway) if !gateway.is_empty() => format!("{} via {}", path.interface, gateway),
        _ => path.interface.clone(),
    }
}

#[cfg(target_os = "linux")]
async fn linux_interface_carrier_up(interface: &str) -> Option<bool> {
    let path = format!("/sys/class/net/{interface}/carrier");
    let content = tokio::fs::read_to_string(path).await.ok()?;
    match content.trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
async fn base_network_path_is_usable(path: &NetworkPath) -> bool {
    linux_interface_carrier_up(&path.interface).await.unwrap_or(true)
}

#[cfg(not(target_os = "linux"))]
async fn base_network_path_is_usable(_path: &NetworkPath) -> bool {
    true
}

#[cfg(target_os = "linux")]
async fn get_primary_network_path() -> Option<NetworkPath> {
    let out = Command::new("ip")
        .args(["route", "show", "default"])
        .output()
        .await
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("default") {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        let mut interface: Option<String> = None;
        let mut gateway: Option<String> = None;
        let mut i = 0usize;

        while i < parts.len() {
            match parts[i] {
                "dev" if i + 1 < parts.len() => {
                    interface = Some(parts[i + 1].to_string());
                    i += 1;
                }
                "via" if i + 1 < parts.len() => {
                    gateway = Some(parts[i + 1].to_string());
                    i += 1;
                }
                _ => {}
            }
            i += 1;
        }

        let interface = interface?;
        if is_vpn_interface(&interface) {
            continue;
        }

        return Some(NetworkPath { interface, gateway });
    }

    None
}

#[cfg(target_os = "macos")]
async fn get_primary_network_path() -> Option<NetworkPath> {
    let out = Command::new("route")
        .args(["-n", "get", "default"])
        .output()
        .await
        .ok()?;

    if !out.status.success() {
        return None;
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut interface: Option<String> = None;
    let mut gateway: Option<String> = None;

    for line in stdout.lines() {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("interface:") {
            interface = Some(value.trim().to_string());
        } else if let Some(value) = trimmed.strip_prefix("gateway:") {
            gateway = Some(value.trim().to_string());
        }
    }

    let interface = interface?;
    if is_vpn_interface(&interface) {
        return None;
    }

    Some(NetworkPath { interface, gateway })
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
async fn get_primary_network_path() -> Option<NetworkPath> {
    Some(NetworkPath {
        interface: "default".to_string(),
        gateway: None,
    })
}

// ---------------- Session lifecycle ----------------

async fn set_status(state: &SharedState, app: &AppHandle<RT>, st: UiStatus) {
    let mut g = state.lock().await;
    g.status = st;
    if st != UiStatus::Connected {
        g.last_connected_at_ms = None;
    }
    emit_status(app, st.as_str());
    update_tray_ui(app, st);
}

#[cfg(unix)]
async fn terminate_child_gracefully(
    app: &AppHandle<RT>,
    child: &mut tokio::process::Child,
    label: &str,
) {
    if let Some(pid) = child.id() {
        emit_log(app, &format!("[ui] Sending SIGTERM to {label} pid={pid}"));
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }

        match time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) => {
                let code = status.code().unwrap_or(-1);
                emit_log(app, &format!("[ui] {label} exited after SIGTERM (code={code})"));
            }
            Ok(Err(e)) => {
                emit_log(app, &format!("[ui] Failed waiting for {label} after SIGTERM: {e}"));
            }
            Err(_) => {
                emit_log(
                    app,
                    &format!("[ui] {label} did not exit after SIGTERM, sending SIGKILL"),
                );
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
        }
    } else {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

#[cfg(not(unix))]
async fn terminate_child_gracefully(
    _app: &AppHandle<RT>,
    child: &mut tokio::process::Child,
    _label: &str,
) {
    let _ = child.kill().await;
    let _ = child.wait().await;
}

async fn set_error_and_disconnect(state: &SharedState, app: &AppHandle<RT>, msg: String) {
    {
        let mut g = state.lock().await;
        g.status = UiStatus::Disconnected;
        g.last_connected_at_ms = None;
    }
    emit_status(app, &format!("error: {msg}"));
    emit_status(app, UiStatus::Disconnected.as_str());
    update_tray_ui(app, UiStatus::Disconnected);
}

async fn stop_current_session(app: &AppHandle<RT>, state: &SharedState) {
    let stop_tx = {
        let mut g = state.lock().await;
        g.disconnect_requested = true;

        if let Some(sess) = &g.session {
            emit_log(app, "[ui] Stop requested");
            Some(sess.stop_tx.clone())
        } else {
            g.status = UiStatus::Disconnected;
            g.last_connected_at_ms = None;
            None
        }
    };

    let Some(stop_tx) = stop_tx else {
        emit_status(app, UiStatus::Disconnected.as_str());
        update_tray_ui(app, UiStatus::Disconnected);
        cleanup_killswitch_when_disabled(app, state).await;
        return;
    };

    let _ = stop_tx.send(true);

    match time::timeout(Duration::from_secs(8), async {
        loop {
            let session_gone = {
                let g = state.lock().await;
                g.session.is_none()
            };

            if session_gone {
                break;
            }

            time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    {
        Ok(_) => emit_log(app, "[ui] OpenVPN session stopped"),
        Err(_) => {
            emit_log(app, "[ui] Timed out waiting for OpenVPN to stop");
            set_status(state, app, UiStatus::Disconnected).await;
        }
    }

    cleanup_killswitch_when_disabled(app, state).await;
}

async fn wait_for_base_network(
    app: &AppHandle<RT>,
    state: &SharedState,
    max_wait_secs: u64,
) -> Option<NetworkPath> {
    let start = time::Instant::now();
    let mut logged_round = 0u64;
    let mut stable_path: Option<NetworkPath> = None;
    let mut stable_hits = 0u32;

    loop {
        if let Some(current) = get_primary_network_path().await {
            if base_network_path_is_usable(&current).await {
                if stable_path.as_ref() == Some(&current) {
                    stable_hits += 1;
                } else {
                    emit_log(
                        app,
                        &format!(
                            "[ui] Found base network {}. Waiting for it to stabilize...",
                            network_path_label(&current)
                        ),
                    );
                    stable_path = Some(current.clone());
                    stable_hits = 1;
                }

                if stable_hits >= 2 {
                    let mut g = state.lock().await;
                    g.last_base_network_path = Some(current.clone());
                    g.network_loss_streak = 0;
                    return Some(current);
                }
            } else {
                stable_path = None;
                stable_hits = 0;
            }
        } else {
            stable_path = None;
            stable_hits = 0;
        }

        let elapsed = start.elapsed().as_secs();
        if elapsed >= max_wait_secs {
            emit_log(
                app,
                "[ui] Base network did not come back in time. Stellar VPN will stay disconnected until you reconnect manually.",
            );
            return None;
        }

        if logged_round == 0 || logged_round % 5 == 4 {
            emit_log(
                app,
                &format!(
                    "[ui] Waiting for base network to return... {elapsed}s/{max_wait_secs}s"
                ),
            );
        }

        logged_round += 1;
        time::sleep(Duration::from_secs(1)).await;
    }
}

async fn auto_reconnect_after_network_change(
    app: AppHandle<RT>,
    state: SharedState,
    reason: String,
) {
    let remembered = {
        let mut g = state.lock().await;

        if g.auto_reconnect_running {
            return;
        }

        let Some(cfg) = g.last_config_source.clone() else {
            return;
        };
        let Some(username) = g.last_username.clone() else {
            return;
        };
        let Some(password) = g.last_password.clone() else {
            return;
        };

        g.auto_reconnect_running = true;
        g.last_connected_at_ms = None;
        (cfg, username, password)
    };

    emit_log(&app, &format!("[ui] {reason}"));
    emit_log(
        &app,
        "[ui] Stellar VPN is rebuilding the connection on the current network.",
    );
    set_status(&state, &app, UiStatus::Connecting).await;

    #[cfg(target_os = "macos")]
    {
        let mut g = state.lock().await;
        g.disconnect_requested = false;
        drop(g);
    }

    #[cfg(not(target_os = "macos"))]
    {
        stop_current_session(&app, &state).await;
    }

    if let Some(path) = wait_for_base_network(&app, &state, NETWORK_RECOVERY_WAIT_SECS).await {
        emit_log(
            &app,
            &format!(
                "[ui] Base network is stable on {}. Reconnecting VPN...",
                network_path_label(&path)
            ),
        );

        for attempt in 1..=NETWORK_RECONNECT_RETRIES {
            emit_log(
                &app,
                &format!(
                    "[ui] Automatic reconnect attempt {attempt}/{NETWORK_RECONNECT_RETRIES}"
                ),
            );

            match vpn_connect_inner(
                app.clone(),
                &state,
                remembered.0.clone(),
                remembered.1.clone(),
                remembered.2.clone(),
            )
            .await
            {
                Ok(()) => {
                    emit_log(&app, "[ui] Automatic reconnect started.");
                    break;
                }
                Err(e) if attempt < NETWORK_RECONNECT_RETRIES => {
                    emit_log(&app, &format!("[ui] Automatic reconnect failed: {e}"));
                    time::sleep(Duration::from_secs(NETWORK_RECONNECT_RETRY_DELAY_SECS)).await;
                }
                Err(e) => {
                    emit_log(&app, &format!("[ui] Automatic reconnect failed: {e}"));
                    set_error_and_disconnect(&state, &app, e).await;
                    break;
                }
            }
        }
    } else {
        set_status(&state, &app, UiStatus::Disconnected).await;
    }

    let mut g = state.lock().await;
    g.auto_reconnect_running = false;
    g.network_loss_streak = 0;
}

async fn monitor_network_health_once(
    app: &AppHandle<RT>,
    state: &SharedState,
    had_resume_gap: bool,
) {
    let current_path = get_primary_network_path().await;
    let last_path_snapshot = { state.lock().await.last_base_network_path.clone() };
    let current_usable = match &current_path {
        Some(path) => base_network_path_is_usable(path).await,
        None => false,
    };
    let tracked_path = current_path.clone().or(last_path_snapshot.clone());
    let tracked_usable = match &tracked_path {
        Some(path) => base_network_path_is_usable(path).await,
        None => false,
    };

    let mut reason: Option<String> = None;

    {
        let mut g = state.lock().await;

        if g.auto_reconnect_running {
            return;
        }

        let should_monitor = matches!(g.status, UiStatus::Connected | UiStatus::Connecting)
            || g.session.is_some();

        if !should_monitor {
            g.network_loss_streak = 0;
            g.base_network_interrupted = false;
            if let Some(path) = current_path.clone() {
                if current_usable {
                    g.last_base_network_path = Some(path);
                }
            }
            return;
        }

        if !tracked_usable {
            if !g.base_network_interrupted {
                if let Some(last_connected_at_ms) = g.last_connected_at_ms {
                    if now_ms().saturating_sub(last_connected_at_ms) < POST_CONNECT_LOSS_GRACE_MS {
                        return;
                    }
                }
                let label = tracked_path
                    .as_ref()
                    .map(network_path_label)
                    .unwrap_or_else(|| "unknown interface".to_string());
                emit_log(
                    app,
                    &format!("[ui] Base network lost on {label}. Waiting for it to return..."),
                );
            }
            g.base_network_interrupted = true;
            g.network_loss_streak = 0;
            return;
        }

        if g.base_network_interrupted {
            let label = current_path
                .as_ref()
                .or(tracked_path.as_ref())
                .map(network_path_label)
                .unwrap_or_else(|| "current network".to_string());
            reason = Some(format!(
                "Base network returned on {label}. Rebuilding VPN.",
            ));
            g.base_network_interrupted = false;
            g.network_loss_streak = 0;
            if let Some(path) = current_path.clone() {
                if current_usable {
                    g.last_base_network_path = Some(path);
                }
            }
        } else {
            if let Some(last_connected_at_ms) = g.last_connected_at_ms {
                if now_ms().saturating_sub(last_connected_at_ms) < POST_CONNECT_MONITOR_COOLDOWN_MS {
                    g.network_loss_streak = 0;
                    if let Some(path) = current_path.clone() {
                        if current_usable {
                            g.last_base_network_path = Some(path);
                        }
                    }
                    return;
                }
            }

            if had_resume_gap {
                reason = Some(
                    "System resume detected. Rebuilding VPN on the current network.".to_string(),
                );
            } else {
                g.network_loss_streak = 0;
                match current_path.clone() {
                    Some(current) if current_usable => {
                        if let Some(previous) = g.last_base_network_path.clone() {
                            if previous != current {
                                reason = Some(format!(
                                    "Base network changed from {} to {}. Rebuilding VPN.",
                                    network_path_label(&previous),
                                    network_path_label(&current)
                                ));
                            } else {
                                g.last_base_network_path = Some(current);
                            }
                        } else {
                            g.last_base_network_path = Some(current);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(reason) = reason {
        auto_reconnect_after_network_change(app.clone(), state.clone(), reason).await;
    }
}

fn spawn_network_health_watcher(app: AppHandle<RT>, state: SharedState) {
    tauri::async_runtime::spawn(async move {
        let mut last_tick = time::Instant::now();

        loop {
            time::sleep(Duration::from_millis(NETWORK_HEALTH_POLL_MS)).await;
            let now = time::Instant::now();
            let gap = now.duration_since(last_tick);
            last_tick = now;

            let had_resume_gap = gap >= Duration::from_secs(RESUME_GAP_SECS);
            let app2 = app.clone();
            let state2 = state.clone();

            tauri::async_runtime::spawn(async move {
                monitor_network_health_once(&app2, &state2, had_resume_gap).await;
            });
        }
    });
}

async fn run_openvpn_session(
    app: AppHandle<RT>,
    state: SharedState,
    sid: u64,
    cfg_path: PathBuf,
    auth_path: PathBuf,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    watchdog_ms: u64,
) {
    emit_log(&app, &format!("[ui] Starting OpenVPN (sid={sid})"));
    emit_log(
        &app,
        &format!("[ui] Using config file: {}", cfg_path.display()),
    );

    let openvpn_bin = match resolve_openvpn_binary(&app) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_file(&auth_path);
            set_error_and_disconnect(&state, &app, e).await;
            return;
        }
    };

    emit_log(
        &app,
        &format!("[ui] OpenVPN binary: {}", openvpn_bin.display()),
    );

    let mut cmd = Command::new(&openvpn_bin);
    cmd.kill_on_drop(true)
        .arg("--config")
        .arg(&cfg_path)
        .arg("--auth-user-pass")
        .arg(&auth_path)
        .arg("--auth-nocache")
        .arg("--redirect-gateway")
        .arg("def1")
        .arg("--verb")
        .arg("3")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&auth_path);
            set_error_and_disconnect(&state, &app, format!("Failed to start openvpn: {e}")).await;
            return;
        }
    };

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    let stdout_task = if let Some(out) = stdout {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(out).lines();
            while let Ok(Some(line)) = r.next_line().await {
                let _ = tx.send(line);
            }
        })
    } else {
        tokio::spawn(async {})
    };

    let stderr_task = if let Some(err) = stderr {
        let tx = line_tx.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(err).lines();
            while let Ok(Some(line)) = r.next_line().await {
                let _ = tx.send(line);
            }
        })
    } else {
        tokio::spawn(async {})
    };

    let watchdog_deadline = time::Instant::now() + Duration::from_millis(watchdog_ms);
    let mut init_done = false;

    loop {
        tokio::select! {
          _ = stop_rx.changed() => {
            if *stop_rx.borrow() {
              emit_log(&app, "[ui] Stop signal received, terminating OpenVPN...");
              terminate_child_gracefully(&app, &mut child, "OpenVPN").await;
              set_status(&state, &app, UiStatus::Disconnected).await;
              break;
            }
          }

          Some(line) = line_rx.recv() => {
            emit_log(&app, &line);

            if !init_done && line.contains("Initialization Sequence Completed") {
              init_done = true;
              {
                  let mut g = state.lock().await;
                  g.last_connected_at_ms = Some(now_ms());
              }
              emit_log(&app, "[ui] OpenVPN reports Initialization Sequence Completed");
              set_status(&state, &app, UiStatus::Connected).await;
            }

            if line.contains("AUTH_FAILED") || line.contains("auth-failure") {
              emit_log(&app, "[ui] Auth failed, stopping...");
              terminate_child_gracefully(&app, &mut child, "OpenVPN").await;
              set_error_and_disconnect(&state, &app, "OpenVPN authentication failed (AUTH_FAILED).".to_string()).await;
              break;
            }
          }

          _ = time::sleep_until(watchdog_deadline), if !init_done => {
            emit_log(&app, &format!("[ui] Connect watchdog fired after {watchdog_ms}ms"));
            terminate_child_gracefully(&app, &mut child, "OpenVPN").await;
            set_error_and_disconnect(&state, &app, format!("Connect timed out after {watchdog_ms}ms (no Initialization Sequence Completed).")).await;
            break;
          }

          res = child.wait() => {
            let code = match res {
              Ok(s) => s.code().unwrap_or(-1),
              Err(_) => -1,
            };

            emit_log(&app, &format!("[ui] OpenVPN exited (code={code})"));

            let manual = {
              let g = state.lock().await;
              g.disconnect_requested
            };

            if !manual && !init_done {
              set_error_and_disconnect(&state, &app, format!("OpenVPN exited before connection was established (code={code}).")).await;
            } else {
              set_status(&state, &app, UiStatus::Disconnected).await;
            }

            break;
          }
        }
    }

    let _ = stdout_task.await;
    let _ = stderr_task.await;

    let _ = fs::remove_file(&auth_path);

    let ks_enabled = { state.lock().await.kill_switch_enabled };
    if cfg_path.starts_with(temp_dir()) && !ks_enabled {
        let _ = tokio::fs::remove_file(&cfg_path).await;
    }

    let mut g = state.lock().await;
    if let Some(sess) = &g.session {
        if sess.sid == sid {
            g.session = None;
        }
    }
}

// ---------------- Commands ----------------

async fn vpn_connect_inner(
    app: AppHandle<RT>,
    state: &SharedState,
    config_path: String,
    username: String,
    password: String,
) -> Result<(), String> {
    {
        let mut g = state.lock().await;
        if g.connect_request_running {
            return Err("VPN connect already in progress.".to_string());
        }
        g.connect_request_running = true;
    }

    let result: Result<(), String> = async {
        let cfg_source = config_path.trim().to_string();
        if cfg_source.is_empty() {
            return Err("configPath is required".to_string());
        }
        if username.trim().is_empty() || password.trim().is_empty() {
            return Err("username/password are required".to_string());
        }

        let current_base_network = get_primary_network_path().await;

        let (ks_enabled, cur_status, last_src, last_cached) = {
            let g = state.lock().await;
            (
                g.kill_switch_enabled,
                g.status,
                g.last_config_source.clone(),
                g.last_config_path.clone(),
            )
        };

        let sid = {
            let mut g = state.lock().await;
            let sid = g.next_sid;
            g.next_sid += 1;
            sid
        };

        let mut prefetched_cfg: Option<PathBuf> = None;
        if ks_enabled && cur_status == UiStatus::Connected && looks_like_url(cfg_source.as_str()) {
            emit_log(&app, "[ui] Kill switch ON + VPN connected: prefetching new config over tunnel before switching...");
            let p = prepare_config(cfg_source.as_str(), sid).await?;
            prefetched_cfg = Some(p);
        }

        stop_current_session(&app, state).await;

        {
            let mut g = state.lock().await;
            g.disconnect_requested = false;
        }

        set_status(state, &app, UiStatus::Connecting).await;
        emit_log(
            &app,
            &format!("[ui] Connecting using config: {}", cfg_source),
        );

        let cfg_path: PathBuf = if let Some(p) = prefetched_cfg {
            p
        } else if ks_enabled && looks_like_url(cfg_source.as_str()) {
            if last_src.as_deref() == Some(cfg_source.as_str()) {
                let cached = last_cached.ok_or_else(|| {
                    "Kill switch is ON but no cached config exists yet. Disable kill switch once, connect, then enable it."
                        .to_string()
                })?;
                let p = PathBuf::from(&cached);
                if !p.exists() {
                    return Err(
                        "Kill switch is ON but cached config file is missing. Disable kill switch once, connect, then enable it."
                            .to_string(),
                    );
                }
                p
            } else {
                return Err(
                    "Kill switch is ON and VPN is disconnected, so internet is intentionally blocked. Switch server while connected (so we can prefetch), or disable kill switch once to cache the new config."
                        .to_string(),
                );
            }
        } else {
            prepare_config(cfg_source.as_str(), sid).await?
        };

        let auth_path = write_auth_file(&username, &password, sid)?;

        {
            let mut g = state.lock().await;
            g.last_config_path = Some(cfg_path.to_string_lossy().to_string());
            g.last_config_source = Some(cfg_source.clone());
            g.last_username = Some(username.clone());
            g.last_password = Some(password.clone());
            g.last_connected_at_ms = None;
            if let Some(path) = current_base_network {
                g.last_base_network_path = Some(path);
            }
            g.network_loss_streak = 0;
            g.base_network_interrupted = false;
        }

        let ks_enabled_now = { state.lock().await.kill_switch_enabled };
        if ks_enabled_now {
            let cfg_str = cfg_path.to_string_lossy().to_string();
            emit_log(
                &app,
                &format!("[ui] Kill switch enabled: applying for config {}", cfg_str),
            );
            apply_kill_switch(true, Some(cfg_str.as_str()))
                .await
                .map_err(|e| {
                    emit_log(&app, &format!("[ui] Kill switch apply failed: {e}"));
                    e
                })?;
        }

        #[cfg(target_os = "macos")]
        {
            std::env::set_var("STELLAR_VPN_HELPER_SOCKET", MACOS_HELPER_SOCKET);

            if let Err(e) = macos_installer::ensure_root_helper_installed(&app) {
                set_error_and_disconnect(state, &app, e.clone()).await;
                return Err(format!("Failed to install/start helper: {e}"));
            }

            let openvpn_bin = resolve_openvpn_binary(&app)?;

            if let Err(e) = macos_helper::helper_connect(
                &app,
                state,
                openvpn_bin,
                cfg_path,
                username.to_string(),
                password.to_string(),
            )
            .await
            {
                set_error_and_disconnect(state, &app, e.clone()).await;
                return Err(e);
            }

            return Ok(());
        }

        #[cfg(not(target_os = "macos"))]
        {
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            {
                let mut g = state.lock().await;
                g.session = Some(Session { sid, stop_tx });
            }

            tokio::spawn(run_openvpn_session(
                app,
                state.clone(),
                sid,
                cfg_path,
                auth_path,
                stop_rx,
                CONNECT_WATCHDOG_MS,
            ));

            Ok(())
        }
    }
    .await;

    {
        let mut g = state.lock().await;
        g.connect_request_running = false;
    }

    result
}

#[tauri::command]
fn chmod_exec(path: String) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(&path)
        .map_err(|e| e.to_string())?
        .permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&path, perms).map_err(|e| e.to_string())
}

#[tauri::command]
fn install_appimage_linux(appimage_path: String) -> Result<(), String> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = appimage_path;
        return Err("install_appimage_linux is only supported on Linux.".to_string());
    }

    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::os::unix::fs::PermissionsExt;

        let src = appimage_path.trim();
        if src.is_empty() {
            return Err("appimage_path is empty".to_string());
        }

        let src_path = PathBuf::from(src);
        if !src_path.exists() {
            return Err(format!("AppImage not found: {}", src_path.display()));
        }

        let home = std::env::var("HOME").map_err(|_| "HOME not set".to_string())?;

        let bin_dir = PathBuf::from(&home).join(".local/bin");
        fs::create_dir_all(&bin_dir).map_err(|e| format!("Failed to create ~/.local/bin: {e}"))?;

        let target_path = bin_dir.join("stellar-vpn.AppImage");

        fs::copy(&src_path, &target_path)
            .map_err(|e| format!("Failed to copy AppImage to {}: {e}", target_path.display()))?;

        let mut perms = fs::metadata(&target_path)
            .map_err(|e| format!("Failed to stat target AppImage: {e}"))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&target_path, perms)
            .map_err(|e| format!("Failed to chmod target AppImage: {e}"))?;

        let apps_dir = PathBuf::from(&home).join(".local/share/applications");
        fs::create_dir_all(&apps_dir)
            .map_err(|e| format!("Failed to create applications dir: {e}"))?;

        let desktop_path = apps_dir.join("stellar-vpn.desktop");

        let desktop_entry = format!(
            "[Desktop Entry]\n\
Type=Application\n\
Name=Stellar VPN\n\
Comment=Stellar VPN Desktop\n\
Exec={}\n\
Terminal=false\n\
Categories=Network;Security;\n\
StartupNotify=true\n",
            target_path.display()
        );

        let mut f = fs::File::create(&desktop_path)
            .map_err(|e| format!("Failed to write desktop entry: {e}"))?;
        f.write_all(desktop_entry.as_bytes())
            .map_err(|e| format!("Failed to write desktop entry bytes: {e}"))?;

        Ok(())
    }
}

#[tauri::command]
async fn vpn_prefetch_config(
    app: AppHandle<RT>,
    state: tauri::State<'_, SharedState>,
    config_path: String,
) -> Result<String, String> {
    let cfg = config_path.trim().to_string();
    if cfg.is_empty() {
        return Err("configPath is required".to_string());
    }

    let (ks, st) = {
        let g = state.lock().await;
        (g.kill_switch_enabled, g.status)
    };

    if ks && st != UiStatus::Connected {
        return Err("Kill switch is ON and VPN is not connected; cannot prefetch.".to_string());
    }

    let sid = {
        let mut g = state.lock().await;
        let sid = g.next_sid;
        g.next_sid += 1;
        sid
    };

    let p = prepare_config(&cfg, sid).await?;
    let p_str = p.to_string_lossy().to_string();

    {
        let mut g = state.lock().await;
        g.last_config_path = Some(p_str.clone());
        g.last_config_source = Some(cfg);
    }

    emit_log(&app, &format!("[ui] Prefetched config => {}", p_str));
    Ok(p_str)
}

#[tauri::command]
async fn vpn_connect(
    app: AppHandle<RT>,
    state: tauri::State<'_, SharedState>,
    config_path: String,
    username: String,
    password: String,
) -> Result<(), String> {
    vpn_connect_inner(app, state.inner(), config_path, username, password).await
}

#[tauri::command]
async fn vpn_disconnect(
    app: AppHandle<RT>,
    state: tauri::State<'_, SharedState>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        {
            let mut g = state.lock().await;
            g.disconnect_requested = true;
            g.last_connected_at_ms = None;
        }

        if let Err(e) = macos_helper::helper_disconnect(&app, state.inner()).await {
            {
                let mut g = state.lock().await;
                g.disconnect_requested = false;
            }
            set_error_and_disconnect(state.inner(), &app, e.clone()).await;
            return Err(e);
        }

        set_status(state.inner(), &app, UiStatus::Disconnected).await;
        return Ok(());
    }

    #[cfg(not(target_os = "macos"))]
    {
        stop_current_session(&app, state.inner()).await;
        Ok(())
    }
}

#[tauri::command]
async fn vpn_status(state: tauri::State<'_, SharedState>) -> Result<String, String> {
    let g = state.lock().await;
    Ok(g.status.as_str().to_string())
}

#[derive(serde::Deserialize)]
struct KillSwitchArgs {
    enabled: bool,
    #[serde(alias = "configPath", alias = "config_path")]
    config_path: Option<String>,
}

#[tauri::command]
async fn vpn_set_kill_switch(
    app: AppHandle<RT>,
    state: tauri::State<'_, SharedState>,
    args: KillSwitchArgs,
) -> Result<(), String> {
    if args.enabled {
        let cfg_in: String = if let Some(s) = args
            .config_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            s.to_string()
        } else {
            let g = state.lock().await;
            g.last_config_path
                .clone()
                .ok_or_else(|| "config_path is required when enabling kill switch.".to_string())?
        };

        let sid = {
            let mut g = state.lock().await;
            let sid = g.next_sid;
            g.next_sid += 1;
            sid
        };

        let cfg_path = prepare_config(&cfg_in, sid).await?;
        let cfg_str = cfg_path.to_string_lossy().to_string();

        {
            let mut g = state.lock().await;
            g.last_config_path = Some(cfg_str.clone());
            g.last_config_source = Some(cfg_in.clone());
        }

        apply_kill_switch(true, Some(cfg_str.as_str()))
            .await
            .map_err(|e| {
                emit_log(&app, &format!("[ui] Kill switch enable failed: {e}"));
                e
            })?;

        {
            let mut g = state.lock().await;
            g.kill_switch_enabled = true;
        }

        emit_log(&app, "[ui] Kill switch set: true");
        return Ok(());
    }

    apply_kill_switch(false, None).await.map_err(|e| {
        emit_log(&app, &format!("[ui] Kill switch disable failed: {e}"));
        e
    })?;

    #[cfg(target_os = "linux")]
    {
        if killswitch_table_exists().await {
            return Err("Kill switch disable returned success, but nft table still exists (inet/stellarkillswitch). Refusing to lie.".to_string());
        }
    }

    {
        let mut g = state.lock().await;
        g.kill_switch_enabled = false;
    }

    emit_log(&app, "[ui] Kill switch set: false");
    Ok(())
}

#[tauri::command]
async fn vpn_kill_switch_enabled(state: tauri::State<'_, SharedState>) -> Result<bool, String> {
    let g = state.lock().await;
    Ok(g.kill_switch_enabled)
}

// ---------------- Main ----------------
fn main() {
    let _ = fix_path_env::fix();

    tauri::Builder::default()
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--flag1", "--flag2"])
                .build(),
        )
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let state: SharedState = std::sync::Arc::new(Mutex::new(VpnInner::default()));
            app.manage(state.clone());

            let tray_handles = setup_tray(&app.handle())?;
            app.manage(tray_handles);

            update_tray_ui(&app.handle(), UiStatus::Disconnected);

            #[cfg(target_os = "macos")]
            {
                std::env::set_var("STELLAR_VPN_HELPER_SOCKET", MACOS_HELPER_SOCKET);

                let handle = app.handle().clone();
                if let Err(e) = macos_installer::ensure_root_helper_installed(&handle) {
                    eprintln!("[macos] ensure_root_helper_installed failed: {e}");
                }

                let app_handle = app.handle().clone();
                macos_helper::spawn_helper_subscriber(app_handle, state.clone());
            }

            spawn_network_health_watcher(app.handle().clone(), state.clone());

            if let Some(w) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        hide_main(&app_handle);
                    }
                });
            }

            #[cfg(not(any(target_os = "ios", target_os = "android")))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let autostart_manager = app.autolaunch();
                println!(
                    "registered for autostart? {}",
                    autostart_manager.is_enabled().unwrap_or(false)
                );
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            chmod_exec,
            install_appimage_linux,
            vpn_prefetch_config,
            vpn_connect,
            vpn_disconnect,
            vpn_status,
            vpn_set_kill_switch,
            vpn_kill_switch_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}