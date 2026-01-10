#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{Read, Seek, SeekFrom, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};
use url::Url;

const DEFAULT_OVPN_URL: &str =
    "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

// OpenVPN management interface (localhost only)
const MGMT_HOST: &str = "127.0.0.1";
const MGMT_PORT: u16 = 2077;

struct VpnInner {
    // Best-effort handle while app is running. Do NOT rely on it for always-on.
    process: Option<Child>,

    status: String, // "disconnected" | "connecting" | "connected" | "error: ..."
    auth_path: Option<PathBuf>,

    // Fixed runtime paths so we can recover after restart
    log_path: Option<PathBuf>,
    status_path: Option<PathBuf>,
    pid_path: Option<PathBuf>,

    session_id: u64, // increments on connect/disconnect to stop stale threads
}

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
                auth_path: None,
                log_path: None,
                status_path: None,
                pid_path: None,
                session_id: 0,
            })),
        }
    }
}

#[cfg(target_os = "windows")]
const OPENVPN_CANDIDATES: [&str; 3] = [
    "C:\\Program Files\\OpenVPN\\bin\\openvpn.exe",
    "C:\\Program Files (x86)\\OpenVPN\\bin\\openvpn.exe",
    "openvpn.exe",
];

#[cfg(target_os = "linux")]
const OPENVPN_CANDIDATES: [&str; 3] = ["/usr/sbin/openvpn", "/usr/bin/openvpn", "openvpn"];

#[cfg(target_os = "macos")]
const OPENVPN_CANDIDATES: [&str; 5] = [
    "/opt/homebrew/sbin/openvpn",
    "/usr/local/sbin/openvpn",
    "/opt/homebrew/bin/openvpn",
    "/usr/local/bin/openvpn",
    "openvpn",
];

fn locate_openvpn() -> Option<String> {
    if let Ok(p) = std::env::var("STELLAR_OPENVPN_PATH") {
        if Path::new(&p).exists() {
            return Some(p);
        }
    }

    for c in OPENVPN_CANDIDATES {
        if c == "openvpn" || c == "openvpn.exe" {
            let ok = Command::new(c)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok();
            if ok {
                return Some(c.to_string());
            }
            continue;
        }

        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }

    None
}

fn is_http_url(s: &str) -> bool {
    Url::parse(s)
        .ok()
        .map(|u| u.scheme() == "http" || u.scheme() == "https")
        .unwrap_or(false)
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    fs::write(path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let perm = fs::Permissions::from_mode(0o600);
        fs::set_permissions(path, perm).map_err(|e| format!("Failed to set permissions: {e}"))?;
    }

    Ok(())
}

fn ensure_dir(p: &Path) -> Result<(), String> {
    fs::create_dir_all(p).map_err(|e| format!("Failed to create dir {}: {e}", p.display()))
}

fn app_vpn_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;
    Ok(app_data_dir.join("vpn"))
}

fn vpn_runtime_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let vpn_dir = app_vpn_dir(app)?;
    let run_dir = vpn_dir.join("run");
    let logs_dir = vpn_dir.join("logs");

    ensure_dir(&run_dir)?;
    ensure_dir(&logs_dir)?;

    let pid_path = run_dir.join("openvpn.pid");
    let status_path = run_dir.join("openvpn.status.txt");
    let log_path = logs_dir.join("openvpn.log");

    // Create files with private permissions up-front (so OpenVPN appends safely)
    if !log_path.exists() {
        write_private_file(&log_path, b"")?;
    }
    if !status_path.exists() {
        write_private_file(&status_path, b"")?;
    }

    Ok((log_path, status_path, pid_path))
}

fn download_config_to_app_data(
    app: &tauri::AppHandle,
    config_url: &str,
    bearer_token: Option<&str>,
) -> Result<PathBuf, String> {
    let url = Url::parse(config_url).map_err(|e| format!("Invalid config URL: {e}"))?;
    if url.scheme() != "https" {
        return Err("Config URL must be https".to_string());
    }

    let vpn_dir = app_vpn_dir(app)?;
    let dir = vpn_dir.join("configs");
    ensure_dir(&dir)?;

    let hash = hex::encode(Sha256::digest(config_url.as_bytes()));
    let path = dir.join(format!("{hash}.ovpn"));

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut req = client.get(config_url);

    if let Some(t) = bearer_token {
        if !t.trim().is_empty() {
            req = req.header("Authorization", format!("Bearer {}", t.trim()));
        }
    }

    let resp = req
        .send()
        .map_err(|e| format!("Failed to download config: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("Config download failed: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .map_err(|e| format!("Failed reading config response: {e}"))?;
    if bytes.len() > 2_000_000 {
        return Err("Config file too large (refusing)".to_string());
    }

    let s = std::str::from_utf8(&bytes).unwrap_or("");
    if !s.contains("client") || !s.contains("remote") {
        return Err("Downloaded file does not look like an OpenVPN profile".to_string());
    }

    write_private_file(&path, &bytes)?;
    Ok(path)
}

fn create_auth_file(
    app: &tauri::AppHandle,
    username: &str,
    password: &str,
) -> Result<PathBuf, String> {
    let vpn_dir = app_vpn_dir(app)?;
    let dir = vpn_dir.join("auth");
    ensure_dir(&dir)?;

    // For always-on, keep a stable auth filename so OpenVPN can continue using it.
    // Note: In production you should store creds in OS keychain and generate short-lived tokens.
    let path = dir.join("auth-current.txt");
    let content = format!("{username}\n{password}\n");
    write_private_file(&path, content.as_bytes())?;
    Ok(path)
}

fn set_status(state_arc: &Arc<Mutex<VpnInner>>, app: &tauri::AppHandle, status: &str) {
    if let Ok(mut g) = state_arc.lock() {
        g.status = status.to_string();
    }
    let _ = app.emit("vpn-status", status.to_string());
}

fn session_is_active(state_arc: &Arc<Mutex<VpnInner>>, session_id: u64) -> bool {
    state_arc
        .lock()
        .map(|g| g.session_id == session_id)
        .unwrap_or(false)
}

fn read_pid(pid_path: &Path) -> Option<u32> {
    let s = fs::read_to_string(pid_path).ok()?;
    s.trim().parse::<u32>().ok()
}

fn mgmt_request(cmd: &str) -> Result<String, String> {
    let addr = format!("{MGMT_HOST}:{MGMT_PORT}");
    let mut stream =
        TcpStream::connect(addr).map_err(|e| format!("mgmt connect failed: {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_millis(350)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(350)));

    // Read banner (best-effort)
    let mut buf = [0u8; 2048];
    let _ = stream.read(&mut buf);

    // Send command
    stream
        .write_all(cmd.as_bytes())
        .map_err(|e| format!("mgmt write failed: {e}"))?;
    if !cmd.ends_with('\n') {
        stream
            .write_all(b"\n")
            .map_err(|e| format!("mgmt write newline failed: {e}"))?;
    }

    // Read response until timeout
    let mut out = Vec::new();
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => out.extend_from_slice(&buf[..n]),
            Err(_) => break, // timeout or other read error, good enough
        }
        if out.len() > 32_000 {
            break;
        }
    }

    Ok(String::from_utf8_lossy(&out).to_string())
}

fn parse_mgmt_state(resp: &str) -> Option<&'static str> {
    // Try to find something that looks like CONNECTED / RECONNECTING / EXITING
    let upper = resp.to_uppercase();

    if upper.contains("CONNECTED") && !upper.contains("DISCONNECTED") && !upper.contains("EXITING") {
        return Some("connected");
    }

    if upper.contains("EXITING") || upper.contains("DISCONNECTED") {
        return Some("disconnected");
    }

    if upper.contains("RECONNECTING")
        || upper.contains("TCP_CONNECT")
        || upper.contains("WAIT")
        || upper.contains("AUTH")
        || upper.contains("RESOLVE")
    {
        return Some("connecting");
    }

    None
}

fn tail_file_contains(path: &Path, needle: &str) -> bool {
    let mut file = match fs::OpenOptions::new().read(true).open(path) {
        Ok(f) => f,
        Err(_) => return false,
    };

    // Read last 128KB
    let Ok(meta) = file.metadata() else { return false };
    let len = meta.len();
    let start = len.saturating_sub(131_072);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return false;
    }

    let mut s = String::new();
    if file.read_to_string(&mut s).is_err() {
        return false;
    }

    s.contains(needle)
}

/// Tail the OpenVPN log file and emit vpn-log lines.
/// Also upgrades status to "connected" when the well-known line appears.
/// This is only for UI while app is running. Always-on status is queried via mgmt on reopen.
fn start_log_file_tailer(
    app: tauri::AppHandle,
    state_arc: Arc<Mutex<VpnInner>>,
    log_path: PathBuf,
    session_id: u64,
) {
    std::thread::spawn(move || {
        let mut pos: u64 = 0;
        let mut carry = String::new();

        loop {
            if !session_is_active(&state_arc, session_id) {
                break;
            }

            let mut file = match fs::OpenOptions::new().read(true).open(&log_path) {
                Ok(f) => f,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(300));
                    continue;
                }
            };

            if file.seek(SeekFrom::Start(pos)).is_err() {
                std::thread::sleep(Duration::from_millis(300));
                continue;
            }

            let mut chunk = String::new();
            if file.read_to_string(&mut chunk).is_ok() {
                if let Ok(new_pos) = file.stream_position() {
                    pos = new_pos;
                }

                if !chunk.is_empty() {
                    let mut text = String::new();
                    text.push_str(&carry);
                    text.push_str(&chunk);

                    let ends_with_newline = text.ends_with('\n');
                    let mut lines = text.lines();

                    let last_incomplete = if !ends_with_newline {
                        lines.next_back().map(|s| s.to_string())
                    } else {
                        None
                    };

                    for line in lines {
                        if !session_is_active(&state_arc, session_id) {
                            return;
                        }

                        let _ = app.emit("vpn-log", line.to_string());

                        if line.contains("Initialization Sequence Completed") {
                            set_status(&state_arc, &app, "connected");
                        }

                        if line.contains("AUTH_FAILED") {
                            let _ = app.emit("vpn-log", "[fatal] AUTH_FAILED".to_string());
                            set_status(&state_arc, &app, "disconnected");
                        }
                    }

                    carry = last_incomplete.unwrap_or_default();
                }
            }

            std::thread::sleep(Duration::from_millis(250));
        }
    });
}

#[tauri::command]
fn vpn_status(state: State<'_, VpnState>, app: tauri::AppHandle) -> String {
    // Source of truth for always-on: management interface (if running)
    if let Ok(resp) = mgmt_request("state") {
        if let Some(s) = parse_mgmt_state(&resp) {
            set_status(&state.inner, &app, s);
            return s.to_string();
        }
        // If mgmt is reachable but we couldn't parse, treat as connecting
        set_status(&state.inner, &app, "connecting");
        return "connecting".to_string();
    }

    // Fallback: pid + log tail hints
    let (log_path, _status_path, pid_path) = match vpn_runtime_paths(&app) {
        Ok(v) => v,
        Err(_) => {
            return "disconnected".to_string();
        }
    };

    let pid = read_pid(&pid_path);
    if pid.is_none() {
        set_status(&state.inner, &app, "disconnected");
        return "disconnected".to_string();
    }

    if tail_file_contains(&log_path, "Initialization Sequence Completed") {
        set_status(&state.inner, &app, "connected");
        return "connected".to_string();
    }

    set_status(&state.inner, &app, "connecting");
    "connecting".to_string()
}

#[tauri::command]
fn vpn_disconnect(state: State<'_, VpnState>, app: tauri::AppHandle) -> Result<(), String> {
    // Stop watchers
    let auth_path = {
        let mut guard = state.inner.lock().unwrap();
        guard.session_id = guard.session_id.saturating_add(1);

        // Best-effort kill handle if we have it
        if let Some(mut child) = guard.process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }

        guard.status = "disconnected".to_string();
        guard.log_path = None;
        guard.status_path = None;
        guard.pid_path = None;

        guard.auth_path.take()
    };

    // Preferred: tell OpenVPN to exit via mgmt
    let _ = mgmt_request("signal SIGTERM");

    // Cleanup auth file
    if let Some(p) = auth_path {
        let _ = fs::remove_file(p);
    }

    set_status(&state.inner, &app, "disconnected");
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn vpn_connect(
    window: tauri::Window,
    state: State<'_, VpnState>,
    config_path: String,
    bearer_token: Option<String>,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let app = window.app_handle();
    let state_arc = state.inner.clone();

    // If mgmt is already reachable, VPN is running (always-on)
    if mgmt_request("state").is_ok() {
        set_status(&state_arc, &app, "connected");
        return Err("VPN already running (management interface reachable)".into());
    }

    // Prevent double-connect in this process
    let session_id = {
        let mut guard = state_arc.lock().unwrap();
        if guard.process.is_some() {
            return Err("VPN already running".into());
        }

        guard.session_id = guard.session_id.saturating_add(1);
        let sid = guard.session_id;

        guard.status = "connecting".to_string();
        guard.auth_path = None;
        guard.log_path = None;
        guard.status_path = None;
        guard.pid_path = None;

        sid
    };

    let _ = app.emit("vpn-status", "connecting".to_string());

    // Resolve config path (DO NOT override unless empty)
    let cfg_in = if config_path.trim().is_empty() {
        DEFAULT_OVPN_URL.to_string()
    } else {
        config_path
    };

    let resolved_config_path = if is_http_url(&cfg_in) {
        download_config_to_app_data(&app, &cfg_in, bearer_token.as_deref())?
    } else {
        PathBuf::from(&cfg_in)
    };

    if !resolved_config_path.exists() {
        set_status(&state_arc, &app, "disconnected");
        return Err(format!(
            "Config file does not exist: {}",
            resolved_config_path.display()
        ));
    }

    let openvpn_path = locate_openvpn().ok_or("OpenVPN binary not found")?;

    // Auth file (optional)
    let auth_path = match (username.as_deref(), password.as_deref()) {
        (Some(u), Some(p)) if !u.trim().is_empty() && !p.trim().is_empty() => {
            Some(create_auth_file(&app, u.trim(), p.trim())?)
        }
        _ => None,
    };

    // Fixed runtime files (survive restarts)
    let (log_path, status_path, pid_path) = vpn_runtime_paths(&app)?;

    // Ensure OpenVPN-created files are private by default (umask 077)
    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }

    let mut cmd = Command::new(openvpn_path);

    cmd.arg("--config").arg(&resolved_config_path);

    if let Some(ap) = &auth_path {
        cmd.arg("--auth-user-pass").arg(ap);
        cmd.arg("--auth-nocache");
    }

    // Always-on essentials
    cmd.arg("--management")
        .arg(MGMT_HOST)
        .arg(MGMT_PORT.to_string());

    cmd.arg("--writepid").arg(&pid_path);

    // Logs/status files
    cmd.arg("--log-append").arg(&log_path);
    cmd.arg("--status").arg(&status_path).arg("1");
    cmd.arg("--verb").arg("6");

    // OpenVPN often doesn't emit meaningful stdout/stderr; use log file + mgmt instead
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    // Detach-ish so closing UI doesn't kill VPN in weird setups
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }

    let child = cmd.spawn().map_err(|e| {
        if let Some(p) = &auth_path {
            let _ = fs::remove_file(p);
        }
        format!("Failed to start OpenVPN: {e}")
    })?;

    {
        let mut guard = state_arc.lock().unwrap();
        guard.process = Some(child);
        guard.auth_path = auth_path;
        guard.log_path = Some(log_path.clone());
        guard.status_path = Some(status_path.clone());
        guard.pid_path = Some(pid_path.clone());
    }

    let _ = app.emit("vpn-log", format!("Config path used: {}", cfg_in));
    let _ = app.emit("vpn-log", format!("OpenVPN log file: {}", log_path.display()));
    let _ = app.emit("vpn-log", format!("OpenVPN status file: {}", status_path.display()));
    let _ = app.emit("vpn-log", format!("OpenVPN pid file: {}", pid_path.display()));
    let _ = app.emit("vpn-log", format!("OpenVPN mgmt: {}:{}", MGMT_HOST, MGMT_PORT));

    // Tail log file for UI while app is running
    start_log_file_tailer(app.clone(), state_arc.clone(), log_path.clone(), session_id);

    // watcher thread: if child we spawned exits, update UI
    {
        let app_clone = app.clone();
        let state_clone = state_arc.clone();
        let sid = session_id;

        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_millis(500));

            let mut guard = match state_clone.lock() {
                Ok(g) => g,
                Err(_) => break,
            };

            if guard.session_id != sid {
                break;
            }

            let Some(child) = guard.process.as_mut() else {
                break;
            };

            match child.try_wait() {
                Ok(Some(_)) => {
                    guard.process = None;
                    guard.status = "disconnected".to_string();
                    let _ = app_clone.emit("vpn-status", "disconnected".to_string());
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    guard.process = None;
                    guard.status = format!("error: {e}");
                    let _ = app_clone.emit("vpn-status", guard.status.clone());
                    break;
                }
            }
        });
    }

    Ok(())
}

fn main() {
    let _ = fix_path_env::fix();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(VpnState::new())
        .invoke_handler(tauri::generate_handler![vpn_connect, vpn_disconnect, vpn_status])
        // Always-on UX: "close window" should NOT exit, it should minimize.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.minimize();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
