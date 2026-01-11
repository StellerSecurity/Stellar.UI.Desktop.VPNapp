// src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{Mutex, OnceCell},
    time,
};

type SharedState = std::sync::Arc<Mutex<VpnInner>>;

const CONNECT_WATCHDOG_MS: u64 = 10_000;

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

#[derive(Debug, Clone)]
struct ConnectParams {
    config_path: String,
    username: String,
    password: String,
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

    // Settings toggles
    kill_switch_enabled: bool,
    crash_recovery_enabled: bool,

    // For crash recovery
    last_connect: Option<ConnectParams>,

    // Used to avoid reconnect loops after manual disconnect
    disconnect_requested: bool,

    // Monotonic connect id for sanity
    next_sid: u64,
}

impl Default for VpnInner {
    fn default() -> Self {
        Self {
            status: UiStatus::Disconnected,
            session: None,
            kill_switch_enabled: false,
            crash_recovery_enabled: true,
            last_connect: None,
            disconnect_requested: false,
            next_sid: 1,
        }
    }
}

static APP_HANDLE: OnceCell<AppHandle> = OnceCell::const_new();

fn emit_status(app: &AppHandle, s: &str) {
    let _ = app.emit("vpn-status", s.to_string());
}

fn emit_log(app: &AppHandle, line: &str) {
    let _ = app.emit("vpn-log", line.to_string());
}

#[allow(dead_code)]
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::from_secs(0))
        .as_millis() as u64
}

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

    // OpenVPN expects:
    // line1=username
    // line2=password
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

    // Tight timeouts so "no internet" doesn't feel like a freeze.
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
        return Err(format!(
            "Failed to download config: HTTP {}",
            resp.status()
        ));
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

#[cfg(target_os = "linux")]
fn linux_has_cap_net_admin() -> bool {
    const CAP_NET_ADMIN_BIT: u32 = 12;

    // root is always fine
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
            if !stdout.is_empty() {
                format!("stdout:\n{stdout}\n")
            } else {
                "".into()
            },
            if !stderr.is_empty() {
                format!("stderr:\n{stderr}\n")
            } else {
                "".into()
            }
        ));
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn parse_openvpn_remotes(config_text: &str) -> Vec<(String, u16, String)> {
    let mut proto = "udp".to_string(); // default
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

    run_cmd(
        "nft",
        &["add","rule","inet","stellarkillswitch","output","oifname","\"lo\"","accept"],
    )
    .await?;
    run_cmd(
        "nft",
        &["add","rule","inet","stellarkillswitch","output","oifname","\"tun0\"","accept"],
    )
    .await?;

    run_cmd(
        "nft",
        &["add","rule","inet","stellarkillswitch","output","udp","dport","53","accept"],
    )
    .await?;
    run_cmd(
        "nft",
        &["add","rule","inet","stellarkillswitch","output","tcp","dport","53","accept"],
    )
    .await?;

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

                if proto.contains("tcp") {
                    if ip.is_ipv4() {
                        let _ = run_cmd(
                            "nft",
                            &["add","rule","inet","stellarkillswitch","output","ip","daddr",&ip_s,"tcp","dport",&port.to_string(),"accept"],
                        )
                        .await;
                    } else {
                        let _ = run_cmd(
                            "nft",
                            &["add","rule","inet","stellarkillswitch","output","ip6","daddr",&ip_s,"tcp","dport",&port.to_string(),"accept"],
                        )
                        .await;
                    }
                } else {
                    if ip.is_ipv4() {
                        let _ = run_cmd(
                            "nft",
                            &["add","rule","inet","stellarkillswitch","output","ip","daddr",&ip_s,"udp","dport",&port.to_string(),"accept"],
                        )
                        .await;
                    } else {
                        let _ = run_cmd(
                            "nft",
                            &["add","rule","inet","stellarkillswitch","output","ip6","daddr",&ip_s,"udp","dport",&port.to_string(),"accept"],
                        )
                        .await;
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

async fn stop_current_session(app: &AppHandle, state: &SharedState) {
    let mut g = state.lock().await;
    g.disconnect_requested = true;

    if let Some(sess) = g.session.take() {
        let _ = sess.stop_tx.send(true);
        emit_log(app, "[ui] Stop requested");
    }

    g.status = UiStatus::Disconnected;
    emit_status(app, UiStatus::Disconnected.as_str());
}

async fn set_status(state: &SharedState, app: &AppHandle, st: UiStatus) {
    let mut g = state.lock().await;
    g.status = st;
    emit_status(app, st.as_str());
}

async fn set_error_and_disconnect(state: &SharedState, app: &AppHandle, msg: String) {
    {
        let mut g = state.lock().await;
        g.status = UiStatus::Disconnected;
    }
    emit_status(app, &format!("error: {msg}"));
    emit_status(app, UiStatus::Disconnected.as_str());
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionOutcome {
    ManualStop,
    ConnectedThenExited,
    ExitedBeforeInit,
    TimedOut,
    AuthFailed,
    SpawnFailed,
}

impl SessionOutcome {
    fn ever_connected(&self) -> bool {
        matches!(self, SessionOutcome::ConnectedThenExited)
    }

    fn is_failure_before_connect(&self) -> bool {
        matches!(
            self,
            SessionOutcome::ExitedBeforeInit
                | SessionOutcome::TimedOut
                | SessionOutcome::AuthFailed
                | SessionOutcome::SpawnFailed
        )
    }
}

async fn run_openvpn_session_inner(
    app: AppHandle,
    state: SharedState,
    sid: u64,
    cfg_path: PathBuf,
    auth_path: PathBuf,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
    watchdog_ms: u64,
) -> SessionOutcome {
    emit_log(&app, &format!("[ui] Starting OpenVPN (sid={sid})"));
    emit_log(
        &app,
        &format!("[ui] Using config file: {}", cfg_path.to_string_lossy()),
    );

    let mut cmd = Command::new("openvpn");
    cmd.arg("--config")
        .arg(&cfg_path)
        .arg("--auth-user-pass")
        .arg(&auth_path)
        .arg("--verb")
        .arg("3")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let _ = fs::remove_file(&auth_path);
            set_error_and_disconnect(&state, &app, format!("Failed to start openvpn: {e}")).await;
            return SessionOutcome::SpawnFailed;
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

    let outcome: SessionOutcome;

    loop {
        tokio::select! {
            _ = stop_rx.changed() => {
                if *stop_rx.borrow() {
                    emit_log(&app, "[ui] Stop signal received, killing OpenVPN...");
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    set_status(&state, &app, UiStatus::Disconnected).await;
                    outcome = SessionOutcome::ManualStop;
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
                    outcome = SessionOutcome::AuthFailed;
                    break;
                }

                if line.contains("TLS Error") && !init_done {
                    emit_log(&app, "[ui] TLS Error detected while connecting");
                }
            }

            _ = time::sleep_until(watchdog_deadline), if !init_done => {
                emit_log(&app, &format!("[ui] Connect watchdog fired after {watchdog_ms}ms"));
                let _ = child.kill().await;
                let _ = child.wait().await;
                set_error_and_disconnect(
                    &state,
                    &app,
                    format!("Connect timed out after {watchdog_ms}ms (no Initialization Sequence Completed).")
                ).await;
                outcome = SessionOutcome::TimedOut;
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
                    set_error_and_disconnect(
                        &state,
                        &app,
                        format!("OpenVPN exited before connection was established (code={code}).")
                    ).await;
                    outcome = SessionOutcome::ExitedBeforeInit;
                } else {
                    set_status(&state, &app, UiStatus::Disconnected).await;
                    outcome = if init_done {
                        SessionOutcome::ConnectedThenExited
                    } else {
                        SessionOutcome::ManualStop
                    };
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

    outcome
}

async fn connect_supervisor(app: AppHandle, state: SharedState, params: ConnectParams) {
    let mut failures_before_connect: u32 = 0;
    let mut current_params = params;

    loop {
        let sid = {
            let mut g = state.lock().await;
            let sid = g.next_sid;
            g.next_sid += 1;

            g.last_connect = Some(current_params.clone());
            g.disconnect_requested = false;

            sid
        };

        set_status(&state, &app, UiStatus::Connecting).await;
        emit_log(&app, &format!("[ui] Connecting using config: {}", current_params.config_path));

        let cfg_path = match prepare_config(&current_params.config_path, sid).await {
            Ok(p) => p,
            Err(e) => {
                emit_log(&app, &format!("[ui] vpn_connect failed: {e}"));
                set_error_and_disconnect(&state, &app, e).await;

                failures_before_connect += 1;
                if failures_before_connect >= 3 {
                    emit_log(&app, "[ui] Giving up after 3 failed attempts before connection.");
                    break;
                }

                let should_retry = {
                    let g = state.lock().await;
                    g.crash_recovery_enabled && !g.disconnect_requested
                };

                if should_retry {
                    emit_log(&app, "[ui] Crash recovery retry in 1s...");
                    time::sleep(Duration::from_millis(1000)).await;
                    continue;
                } else {
                    break;
                }
            }
        };

        let auth_path = match write_auth_file(&current_params.username, &current_params.password, sid) {
            Ok(p) => p,
            Err(e) => {
                emit_log(&app, &format!("[ui] vpn_connect failed: {e}"));
                set_error_and_disconnect(&state, &app, e).await;
                break;
            }
        };

        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        {
            let mut g = state.lock().await;
            g.session = Some(Session { sid, stop_tx });
        }

        let outcome = run_openvpn_session_inner(
            app.clone(),
            state.clone(),
            sid,
            cfg_path,
            auth_path,
            stop_rx,
            CONNECT_WATCHDOG_MS,
        )
        .await;

        if outcome.ever_connected() {
            failures_before_connect = 0;
        } else if outcome.is_failure_before_connect() {
            failures_before_connect += 1;
        }

        let (should_recover, last_params, kill_switch_enabled) = {
            let g = state.lock().await;
            (
                g.crash_recovery_enabled && !g.disconnect_requested,
                g.last_connect.clone(),
                g.kill_switch_enabled,
            )
        };

        if !should_recover {
            break;
        }

        if failures_before_connect >= 3 {
            emit_log(&app, "[ui] Crash recovery stopped: too many failures before connection.");
            break;
        }

        if let Some(p) = last_params {
            emit_log(&app, "[ui] Crash recovery enabled: attempting reconnect in 1s...");
            time::sleep(Duration::from_millis(1000)).await;

            if kill_switch_enabled {
                let _ = apply_kill_switch(true, Some(&p.config_path)).await;
            }

            current_params = p;
            continue;
        } else {
            break;
        }
    }

    set_status(&state, &app, UiStatus::Disconnected).await;
}

async fn vpn_connect_internal(app: AppHandle, state: SharedState, params: ConnectParams) -> Result<(), String> {
    tokio::spawn(connect_supervisor(app, state, params));
    Ok(())
}

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

    vpn_connect_internal(
        app,
        state.inner().clone(),
        ConnectParams {
            config_path,
            username,
            password,
        },
    )
    .await
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

#[derive(Debug, Serialize, Deserialize)]
struct KillSwitchArgs {
    enabled: bool,
    config_path: Option<String>,
    bearer_token: Option<String>,
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

#[tauri::command]
async fn vpn_set_crash_recovery(
    app: AppHandle,
    state: tauri::State<'_, SharedState>,
    enabled: bool,
) -> Result<(), String> {
    let mut g = state.lock().await;
    g.crash_recovery_enabled = enabled;
    emit_log(&app, &format!("[ui] Crash recovery set: {enabled}"));
    Ok(())
}

#[tauri::command]
async fn vpn_crash_recovery_enabled(state: tauri::State<'_, SharedState>) -> Result<bool, String> {
    let g = state.lock().await;
    Ok(g.crash_recovery_enabled)
}

fn main() {
    let _ = fix_path_env::fix();

    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();
            APP_HANDLE.set(handle).ok();

            let state: SharedState = std::sync::Arc::new(Mutex::new(VpnInner::default()));
            app.manage(state);

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            vpn_status,
            vpn_set_kill_switch,
            vpn_kill_switch_enabled,
            vpn_set_crash_recovery,
            vpn_crash_recovery_enabled
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
