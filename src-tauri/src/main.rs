// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Wry;
type RT = Wry;


use std::{
    fs,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
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

// These must exist:
// - src-tauri/icons/tray-offline.png
// - src-tauri/icons/tray-online.png
const TRAY_ICON_OFFLINE_BYTES: &[u8] = include_bytes!("../icons/tray-offline.png");
const TRAY_ICON_ONLINE_BYTES: &[u8] = include_bytes!("../icons/tray-online.png");

// --- Status exposed to UI ---
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
}

impl Default for VpnInner {
    fn default() -> Self {
        Self {
            status: UiStatus::Disconnected,
            session: None,
            kill_switch_enabled: false,
            disconnect_requested: false,
            next_sid: 1,
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

fn update_tray_ui(app: &AppHandle<RT>, st: UiStatus) {
    // Enable/disable menu items
    let handles: tauri::State<TrayHandles> = app.state();
    let can_connect = st == UiStatus::Disconnected;
    let can_disconnect = st != UiStatus::Disconnected;

    let _ = handles.connect.set_enabled(can_connect);
    let _ = handles.reconnect.set_enabled(can_connect);
    let _ = handles.disconnect.set_enabled(can_disconnect);

    // Swap tray icon
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        if let Some(img) = tray_icon_for_status(st) {
            let _ = tray.set_icon(Some(img));
        }
    }
}

// ---------------- Tray helpers ----------------

fn show_main(app: &AppHandle<RT>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn hide_main(app: &AppHandle<RT>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.hide();
    }
}

fn setup_tray(app: &AppHandle<RT>) -> tauri::Result<TrayHandles> {
    // Initial state: disconnected => connect/reconnect enabled, disconnect disabled
    let open = MenuItem::with_id(app, "open", "Open Stellar VPN", true, None::<&str>)?;
    let connect = MenuItem::with_id(app, "connect", "Connect", true, None::<&str>)?;
    let reconnect = MenuItem::with_id(app, "reconnect", "Reconnect", true, None::<&str>)?;
    let disconnect = MenuItem::with_id(app, "disconnect", "Disconnect", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;


    let menu = Menu::with_items(app, &[&open, &connect, &reconnect, &disconnect, &quit])?;

    let icon = Image::from_bytes(TRAY_ICON_OFFLINE_BYTES)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "open" => {
                    show_main(app);
                    let _ = app.emit("tray-open", ());
                }
                "connect" => {
                    let _ = app.emit("tray-connect", ());
                }
                "reconnect" => {
                    let _ = app.emit("tray-reconnect", ());
                }
                "disconnect" => {
                    let _ = app.emit("tray-disconnect", ());
                }
                "quit" => {
                    let _ = app.emit("tray-quit", ());
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, e| {
            // Double-click -> show main
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
        .timeout(Duration::from_secs(8))
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

fn resolve_openvpn_binary(app: &AppHandle) -> Result<PathBuf, String> {
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

// ---------------- Kill switch (linux nftables) ----------------

#[cfg(target_os = "linux")]
fn linux_has_cap_net_admin() -> bool {
    const CAP_NET_ADMIN_BIT: u32 = 12;

    let is_root = unsafe { libc::geteuid() == 0 };
    if is_root {
        return true;
    }

    let s = match fs::read_to_string("/proc/self/status") {
        Ok(v) => v,
        Err(_) => return false,
    };

    let mut capeff_hex: Option<&str> = None;
    for line in s.lines() {
        if line.starts_with("CapEff:") {
            capeff_hex = line.split_whitespace().nth(1);
            break;
        }
    }

    let hexv = match capeff_hex {
        Some(v) => v,
        None => return false,
    };

    let v = match u64::from_str_radix(hexv, 16) {
        Ok(v) => v,
        Err(_) => return false,
    };

    ((v >> CAP_NET_ADMIN_BIT) & 1) == 1
}

#[cfg(not(target_os = "linux"))]
fn linux_has_cap_net_admin() -> bool {
    false
}

#[cfg(target_os = "linux")]
async fn run_cmd(cmd: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(cmd)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("Failed to run {cmd}: {e}"))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "Command failed: {cmd} {:?}\n{}{}",
            args,
            if !stdout.is_empty() { format!("stdout:\n{stdout}\n") } else { "".into() },
            if !stderr.is_empty() { format!("stderr:\n{stderr}\n") } else { "".into() }
        ));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn parse_openvpn_remotes(config_text: &str) -> Vec<(String, u16, String)> {
    let mut proto = "udp".to_string();
    for line in config_text.lines() {
        let l = line.trim();
        if l.starts_with('#') || l.starts_with(';') || l.is_empty() {
            continue;
        }
        if l.starts_with("proto ") {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() >= 2 {
                proto = parts[1].to_lowercase();
            }
        }
    }

    let mut remotes = vec![];
    for line in config_text.lines() {
        let l = line.trim();
        if l.starts_with('#') || l.starts_with(';') || l.is_empty() {
            continue;
        }
        if l.starts_with("remote ") {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() >= 2 {
                let host = parts[1].to_string();
                let port = if parts.len() >= 3 {
                    parts[2].parse::<u16>().unwrap_or(1194)
                } else {
                    1194
                };
                remotes.push((host, port, proto.clone()));
            }
        }
    }
    remotes
}

#[cfg(target_os = "linux")]
async fn resolve_host(host: &str, port: u16) -> Vec<IpAddr> {
    let host = host.to_string();
    tokio::task::spawn_blocking(move || {
        let addr = format!("{host}:{port}");
        match addr.to_socket_addrs() {
            Ok(iter) => iter.map(|sa| sa.ip()).collect(),
            Err(_) => vec![],
        }
    })
    .await
    .unwrap_or_default()
}

#[cfg(target_os = "linux")]
async fn apply_kill_switch(enable: bool, config_path: Option<&str>) -> Result<(), String> {
    if !linux_has_cap_net_admin() {
        return Err("Kill switch needs root or CAP_NET_ADMIN (setcap).".to_string());
    }

    if !enable {
        let _ = run_cmd("nft", &["delete", "table", "inet", "stellarkillswitch"]).await;
        return Ok(());
    }

    let _ = run_cmd("nft", &["add", "table", "inet", "stellarkillswitch"]).await;
    let _ = run_cmd(
        "nft",
        &[
            "add","chain","inet","stellarkillswitch","output",
            "{","type","filter","hook","output","priority","0",";","policy","accept",";","}",
        ],
    )
    .await;

    let _ = run_cmd("nft", &["flush", "chain", "inet", "stellarkillswitch", "output"]).await;

    run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","oifname","\"lo\"","accept"]).await?;
    run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","oifname","\"tun0\"","accept"]).await?;

    run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","udp","dport","53","accept"]).await?;
    run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","tcp","dport","53","accept"]).await?;

    if let Some(cfg) = config_path {
        let cfg_text = if looks_like_url(cfg) {
            let client = reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(3))
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

            let resp = client.get(cfg).send().await.map_err(|e| e.to_string())?;
            resp.text().await.unwrap_or_default()
        } else {
            fs::read_to_string(cfg).unwrap_or_default()
        };

        let remotes = parse_openvpn_remotes(&cfg_text);
        for (host, port, proto) in remotes {
            let ips = resolve_host(&host, port).await;
            for ip in ips {
                let ip_s = ip.to_string();
                let port_s = port.to_string();

                if proto.contains("tcp") {
                    if ip.is_ipv4() {
                        let _ = run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","ip","daddr",&ip_s,"tcp","dport",&port_s,"accept"]).await;
                    } else {
                        let _ = run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","ip6","daddr",&ip_s,"tcp","dport",&port_s,"accept"]).await;
                    }
                } else {
                    if ip.is_ipv4() {
                        let _ = run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","ip","daddr",&ip_s,"udp","dport",&port_s,"accept"]).await;
                    } else {
                        let _ = run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","ip6","daddr",&ip_s,"udp","dport",&port_s,"accept"]).await;
                    }
                }
            }
        }
    }

    run_cmd("nft", &["add","rule","inet","stellarkillswitch","output","drop"]).await?;
    Ok(())
}

#[cfg(not(target_os = "linux"))]
async fn apply_kill_switch(_enable: bool, _config_path: Option<&str>) -> Result<(), String> {
    Err("Kill switch requires admin/root on this platform.".to_string())
}

// ---------------- Session lifecycle ----------------

async fn stop_current_session(app: &AppHandle, state: &SharedState) {
    let mut g = state.lock().await;
    g.disconnect_requested = true;

    if let Some(sess) = g.session.take() {
        let _ = sess.stop_tx.send(true);
        emit_log(app, "[ui] Stop requested");
    }

    g.status = UiStatus::Disconnected;
    emit_status(app, UiStatus::Disconnected.as_str());
    update_tray_ui(app, UiStatus::Disconnected);
}

async fn set_status(state: &SharedState, app: &AppHandle, st: UiStatus) {
    let mut g = state.lock().await;
    g.status = st;
    emit_status(app, st.as_str());
    update_tray_ui(app, st);
}

async fn set_error_and_disconnect(state: &SharedState, app: &AppHandle, msg: String) {
    {
        let mut g = state.lock().await;
        g.status = UiStatus::Disconnected;
    }
    emit_status(app, &format!("error: {msg}"));
    emit_status(app, UiStatus::Disconnected.as_str());
    update_tray_ui(app, UiStatus::Disconnected);
}

async fn run_openvpn_session(
    app: AppHandle,
    state: SharedState,
    sid: u64,
    cfg_path: PathBuf,
    auth_path: PathBuf,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    watchdog_ms: u64,
) {
    emit_log(&app, &format!("[ui] Starting OpenVPN (sid={sid})"));
    emit_log(&app, &format!("[ui] Using config file: {}", cfg_path.display()));

    let openvpn_bin = match resolve_openvpn_binary(&app) {
        Ok(p) => p,
        Err(e) => {
            let _ = fs::remove_file(&auth_path);
            set_error_and_disconnect(&state, &app, e).await;
            return;
        }
    };

    emit_log(&app, &format!("[ui] OpenVPN binary: {}", openvpn_bin.display()));

    let mut cmd = Command::new(&openvpn_bin);
    cmd.kill_on_drop(true)
        .arg("--config")
        .arg(&cfg_path)
        .arg("--auth-user-pass")
        .arg(&auth_path)
        .arg("--auth-nocache")
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
                    emit_log(&app, "[ui] Stop signal received, killing OpenVPN...");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    set_status(&state, &app, UiStatus::Disconnected).await;
                    break;
                }
            }

            Some(line) = line_rx.recv() => {
                emit_log(&app, &line);

                if !init_done && line.contains("Initialization Sequence Completed") {
                    init_done = true;
                    emit_log(&app, "[ui] OpenVPN reports Initialization Sequence Completed");
                    set_status(&state, &app, UiStatus::Connected).await;
                }

                if line.contains("AUTH_FAILED") || line.contains("auth-failure") {
                    emit_log(&app, "[ui] Auth failed, stopping...");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    set_error_and_disconnect(&state, &app, "OpenVPN authentication failed (AUTH_FAILED).".to_string()).await;
                    break;
                }
            }

            _ = time::sleep_until(watchdog_deadline), if !init_done => {
                emit_log(&app, &format!("[ui] Connect watchdog fired after {watchdog_ms}ms"));
                let _ = child.kill().await;
                let _ = child.wait().await;
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

    if cfg_path.starts_with(temp_dir()) {
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

#[tauri::command]
async fn vpn_connect(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    config_path: String,
    username: String,
    password: String,
) -> Result<(), String> {
    stop_current_session(&app, state.inner()).await;

    {
        let mut g = state.lock().await;
        g.disconnect_requested = false;
    }

    if config_path.trim().is_empty() {
        return Err("configPath is required".to_string());
    }
    if username.trim().is_empty() || password.trim().is_empty() {
        return Err("username/password are required".to_string());
    }

    let sid = {
        let mut g = state.lock().await;
        let sid = g.next_sid;
        g.next_sid += 1;
        sid
    };

    set_status(state.inner(), &app, UiStatus::Connecting).await;
    emit_log(&app, &format!("[ui] Connecting using config: {}", config_path));

    let cfg_path = prepare_config(&config_path, sid).await?;
    let auth_path = write_auth_file(&username, &password, sid)?;

    let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
    {
        let mut g = state.lock().await;
        g.session = Some(Session { sid, stop_tx });
    }

    tokio::spawn(run_openvpn_session(
        app,
        state.inner().clone(),
        sid,
        cfg_path,
        auth_path,
        stop_rx,
        CONNECT_WATCHDOG_MS,
    ));

    Ok(())
}

#[tauri::command]
async fn vpn_disconnect(app: AppHandle, state: tauri::State<'_, SharedState>) -> Result<(), String> {
    stop_current_session(&app, state.inner()).await;
    Ok(())
}

#[tauri::command]
async fn vpn_status(state: tauri::State<'_, SharedState>) -> Result<String, String> {
    let g = state.lock().await;
    Ok(g.status.as_str().to_string())
}

#[tauri::command]
async fn vpn_set_kill_switch(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    enabled: bool,
    config_path: Option<String>,
    _bearer_token: Option<String>,
) -> Result<(), String> {
    apply_kill_switch(enabled, config_path.as_deref()).await.map_err(|e| {
        emit_log(&app, &format!("[ui] Kill switch error: {e}"));
        e
    })?;

    let mut g = state.lock().await;
    g.kill_switch_enabled = enabled;
    emit_log(&app, &format!("[ui] Kill switch set: {enabled}"));
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
        .setup(|app| {
            // VPN state
            let state: SharedState = std::sync::Arc::new(Mutex::new(VpnInner::default()));
            app.manage(state);

            // Tray
            let tray_handles = setup_tray(&app.handle())?;
            app.manage(tray_handles);

            // Make sure tray UI matches initial state
            update_tray_ui(&app.handle(), UiStatus::Disconnected);

            // X -> hide to tray (instead of closing)
            if let Some(w) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                w.on_window_event(move |e| {
                    if let WindowEvent::CloseRequested { api, .. } = e {
                        api.prevent_close();
                        hide_main(&app_handle);
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            vpn_status,
            vpn_set_kill_switch,
            vpn_kill_switch_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
