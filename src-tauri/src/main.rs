#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    net::ToSocketAddrs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, Manager, State};
use url::Url;

const DEFAULT_OVPN_URL: &str =
    "https://stellarvpnserverstorage.blob.core.windows.net/openvpn/stellar-switzerland.ovpn";

/// If connecting is stuck, we abort and emit logs.
const CONNECT_STUCK_SECS: u64 = 10;
const CONNECT_STUCK_IDLE_GRACE_MS: u64 = 2_000;

#[cfg(target_os = "linux")]
const TUN_IFNAME: &str = "tun-stellar";

#[derive(Default)]
struct VpnInner {
    process: Option<Child>, // Only for current session (not recoverable after crash)
    pid: Option<u32>,       // Used for crash recovery
    status: String,         // "disconnected" | "connecting" | "connected" | "error: ..."
    auth_path: Option<PathBuf>,
    log_path: Option<PathBuf>,
    status_path: Option<PathBuf>,
    pid_path: Option<PathBuf>,
    session_id: u64,

    // Preferences (persisted)
    killswitch_enabled: bool,
    crash_recovery_enabled: bool,

    // Kill switch / remote endpoint memory
    last_proto: String,           // "udp" | "tcp"
    last_port: u16,               // e.g. 1194
    last_remote_ip: Option<String>,

    // Connect watchdog / progress tracking
    connect_started_at_ms: u64,
    last_log_at_ms: u64,
    last_log_pos: u64,
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
                pid: None,
                status: "disconnected".to_string(),
                auth_path: None,
                log_path: None,
                status_path: None,
                pid_path: None,
                session_id: 0,

                // IMPORTANT: default OFF until you have a privileged helper.
                killswitch_enabled: false,
                crash_recovery_enabled: true,

                last_proto: "udp".to_string(),
                last_port: 1194,
                last_remote_ip: None,

                connect_started_at_ms: 0,
                last_log_at_ms: 0,
                last_log_pos: 0,
            })),
        }
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct SessionFile {
    pid: u32,
    log_path: String,
    status_path: String,
    pid_path: String,
    last_proto: String,
    last_port: u16,
    last_remote_ip: Option<String>,
    killswitch_enabled: bool,
    crash_recovery_enabled: bool,
}

#[derive(Serialize, Deserialize, Debug)]
struct PrefsFile {
    killswitch_enabled: bool,
    crash_recovery_enabled: bool,
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

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

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

// ---- prefs ----
fn prefs_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_vpn_dir(app)?.join("prefs.json"))
}

fn load_prefs(app: &tauri::AppHandle) -> Result<Option<PrefsFile>, String> {
    let p = prefs_file_path(app)?;
    if !p.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&p).map_err(|e| format!("Read prefs file: {e}"))?;
    let pf: PrefsFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("Parse prefs file: {e}"))?;
    Ok(Some(pf))
}

fn save_prefs(app: &tauri::AppHandle, pf: &PrefsFile) -> Result<(), String> {
    let p = prefs_file_path(app)?;
    let bytes = serde_json::to_vec_pretty(pf).map_err(|e| format!("Serialize prefs: {e}"))?;
    write_private_file(&p, &bytes)
}

// ---- session recovery ----
fn session_file_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app_vpn_dir(app)?.join("session.json"))
}

fn save_session_file(app: &tauri::AppHandle, sf: &SessionFile) -> Result<(), String> {
    let p = session_file_path(app)?;
    let bytes = serde_json::to_vec_pretty(sf).map_err(|e| format!("Serialize session: {e}"))?;
    write_private_file(&p, &bytes)
}

fn load_session_file(app: &tauri::AppHandle) -> Result<Option<SessionFile>, String> {
    let p = session_file_path(app)?;
    if !p.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&p).map_err(|e| format!("Read session file: {e}"))?;
    let sf: SessionFile =
        serde_json::from_slice(&bytes).map_err(|e| format!("Parse session file: {e}"))?;
    Ok(Some(sf))
}

fn clear_session_file(app: &tauri::AppHandle) {
    if let Ok(p) = session_file_path(app) {
        let _ = fs::remove_file(p);
    }
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

    let stamp = now_ms();
    let path = dir.join(format!("auth-{stamp}.txt"));

    let content = format!("{username}\n{password}\n");
    write_private_file(&path, content.as_bytes())?;
    Ok(path)
}

fn create_runtime_files(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let vpn_dir = app_vpn_dir(app)?;
    let dir = vpn_dir.join("logs");
    ensure_dir(&dir)?;

    let stamp = now_ms();
    let log_path = dir.join(format!("openvpn-{stamp}.log"));
    let status_path = dir.join(format!("openvpn-{stamp}.status.txt"));
    let pid_path = dir.join(format!("openvpn-{stamp}.pid"));

    write_private_file(&log_path, b"")?;
    write_private_file(&status_path, b"")?;
    write_private_file(&pid_path, b"")?;

    Ok((log_path, status_path, pid_path))
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

fn parse_ovpn_proto_port(contents: &str) -> (String, u16) {
    let mut proto = "udp".to_string();
    let mut port: u16 = 1194;

    for raw in contents.lines() {
        let line = raw.trim();
        if line.starts_with('#') || line.starts_with(';') || line.is_empty() {
            continue;
        }

        if line.starts_with("proto ") {
            let p = line
                .split_whitespace()
                .nth(1)
                .unwrap_or("udp")
                .to_lowercase();
            proto = if p.contains("tcp") {
                "tcp".to_string()
            } else {
                "udp".to_string()
            };
        }

        if line.starts_with("remote ") {
            let mut parts = line.split_whitespace();
            let _ = parts.next();
            let _host = parts.next();
            if let Some(p) = parts.next() {
                if let Ok(v) = p.parse::<u16>() {
                    port = v;
                }
            }
        }
    }

    (proto, port)
}

fn resolve_host_to_ip(host: &str, port: u16) -> Option<String> {
    let addr = format!("{host}:{port}");
    addr.to_socket_addrs()
        .ok()?
        .find(|a| a.is_ipv4())
        .map(|a| a.ip().to_string())
}

fn extract_remote_ip_from_log_line(line: &str) -> Option<(String, u16)> {
    // Example:
    // "UDP link remote: [AF_INET]1.2.3.4:1194"
    // "TCP/UDP: Preserving recently used remote address: [AF_INET]1.2.3.4:1194"
    let idx = line.find(']')?;
    let rest = line[idx + 1..].trim();
    let mut parts = rest.split(':');
    let ip = parts.next()?.trim();
    let port_str = parts.next()?.trim();
    let port: u16 = port_str.parse().ok()?;
    if ip.is_empty() {
        return None;
    }
    Some((ip.to_string(), port))
}

fn tail_last_lines(path: &Path, n: usize) -> Vec<String> {
    let Ok(s) = fs::read_to_string(path) else { return vec![]; };
    let lines: Vec<&str> = s.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].iter().map(|l| l.to_string()).collect()
}

// ----------------- Linux kill switch -----------------
#[cfg(target_os = "linux")]
fn linux_is_root() -> bool {
    unsafe { libc::geteuid() == 0 }
}

#[cfg(target_os = "linux")]
fn linux_cmd_exists(bin: &str) -> bool {
    Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {bin} >/dev/null 2>&1"))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

#[cfg(target_os = "linux")]
fn linux_run_cmd(bin: &str, args: &[&str]) -> Result<(), String> {
    let out = Command::new(bin)
        .args(args)
        .output()
        .map_err(|e| format!("Failed running {bin}: {e}"))?;

    if out.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Err(format!("Command failed: {bin} {:?}\n{stderr}", args))
}

#[cfg(target_os = "linux")]
fn linux_nameservers() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(c) = fs::read_to_string("/etc/resolv.conf") {
        for line in c.lines() {
            let line = line.trim();
            if line.starts_with("nameserver ") {
                if let Some(ip) = line.split_whitespace().nth(1) {
                    out.push(ip.to_string());
                }
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn linux_killswitch_disable() -> Result<(), String> {
    if linux_cmd_exists("nft") {
        let _ = linux_run_cmd("nft", &["delete", "table", "inet", "stellarkillswitch"]);
        return Ok(());
    }

    // iptables cleanup (best-effort)
    let _ = linux_run_cmd("iptables", &["-D", "OUTPUT", "-j", "STELLAR_KILLSWITCH"]);
    let _ = linux_run_cmd("iptables", &["-F", "STELLAR_KILLSWITCH"]);
    let _ = linux_run_cmd("iptables", &["-X", "STELLAR_KILLSWITCH"]);

    let _ = linux_run_cmd("ip6tables", &["-D", "OUTPUT", "-j", "STELLAR_KILLSWITCH"]);
    let _ = linux_run_cmd("ip6tables", &["-F", "STELLAR_KILLSWITCH"]);
    let _ = linux_run_cmd("ip6tables", &["-X", "STELLAR_KILLSWITCH"]);

    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_killswitch_apply_nft(
    proto: &str,
    port: u16,
    remote_ip: Option<&str>,
    allow_any_remote: bool,
) -> Result<(), String> {
    linux_killswitch_disable()?;

    linux_run_cmd("nft", &["add", "table", "inet", "stellarkillswitch"])?;

    // Add output chain with DROP policy
    linux_run_cmd(
        "nft",
        &[
            "add",
            "chain",
            "inet",
            "stellarkillswitch",
            "output",
            "{",
            "type",
            "filter",
            "hook",
            "output",
            "priority",
            "0;",
            "policy",
            "drop;",
            "}",
        ],
    )?;

    // allow loopback
    linux_run_cmd(
        "nft",
        &[
            "add",
            "rule",
            "inet",
            "stellarkillswitch",
            "output",
            "oif",
            "lo",
            "accept",
        ],
    )?;

    // allow established/related
    linux_run_cmd(
        "nft",
        &[
            "add",
            "rule",
            "inet",
            "stellarkillswitch",
            "output",
            "ct",
            "state",
            "established,related",
            "accept",
        ],
    )?;

    // allow tunnel interface
    linux_run_cmd(
        "nft",
        &[
            "add",
            "rule",
            "inet",
            "stellarkillswitch",
            "output",
            "oifname",
            TUN_IFNAME,
            "accept",
        ],
    )?;

    // allow DNS to system resolvers
    for ns in linux_nameservers() {
        linux_run_cmd(
            "nft",
            &[
                "add",
                "rule",
                "inet",
                "stellarkillswitch",
                "output",
                "ip",
                "daddr",
                &ns,
                "udp",
                "dport",
                "53",
                "accept",
            ],
        )?;
        linux_run_cmd(
            "nft",
            &[
                "add",
                "rule",
                "inet",
                "stellarkillswitch",
                "output",
                "ip",
                "daddr",
                &ns,
                "tcp",
                "dport",
                "53",
                "accept",
            ],
        )?;
    }

    // allow VPN endpoint
    let port_s = port.to_string();
    let p = proto.to_lowercase();

    if let Some(ip) = remote_ip {
        linux_run_cmd(
            "nft",
            &[
                "add",
                "rule",
                "inet",
                "stellarkillswitch",
                "output",
                "ip",
                "daddr",
                ip,
                &p,
                "dport",
                &port_s,
                "accept",
            ],
        )?;
    } else if allow_any_remote {
        linux_run_cmd(
            "nft",
            &[
                "add",
                "rule",
                "inet",
                "stellarkillswitch",
                "output",
                &p,
                "dport",
                &port_s,
                "accept",
            ],
        )?;
    }

    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_killswitch_apply_iptables(
    proto: &str,
    port: u16,
    remote_ip: Option<&str>,
    allow_any_remote: bool,
) -> Result<(), String> {
    linux_killswitch_disable()?;

    linux_run_cmd("iptables", &["-N", "STELLAR_KILLSWITCH"])?;
    linux_run_cmd("iptables", &["-I", "OUTPUT", "1", "-j", "STELLAR_KILLSWITCH"])?;

    // allow loopback
    linux_run_cmd("iptables", &["-A", "STELLAR_KILLSWITCH", "-o", "lo", "-j", "ACCEPT"])?;
    // allow established/related
    linux_run_cmd(
        "iptables",
        &[
            "-A",
            "STELLAR_KILLSWITCH",
            "-m",
            "conntrack",
            "--ctstate",
            "ESTABLISHED,RELATED",
            "-j",
            "ACCEPT",
        ],
    )?;
    // allow tunnel
    linux_run_cmd("iptables", &["-A", "STELLAR_KILLSWITCH", "-o", TUN_IFNAME, "-j", "ACCEPT"])?;

    // allow DNS to resolvers
    for ns in linux_nameservers() {
        linux_run_cmd(
            "iptables",
            &["-A", "STELLAR_KILLSWITCH", "-p", "udp", "-d", &ns, "--dport", "53", "-j", "ACCEPT"],
        )?;
        linux_run_cmd(
            "iptables",
            &["-A", "STELLAR_KILLSWITCH", "-p", "tcp", "-d", &ns, "--dport", "53", "-j", "ACCEPT"],
        )?;
    }

    // allow VPN endpoint
    let port_s = port.to_string();
    let p = proto.to_lowercase();

    if let Some(ip) = remote_ip {
        linux_run_cmd(
            "iptables",
            &[
                "-A",
                "STELLAR_KILLSWITCH",
                "-p",
                &p,
                "-d",
                ip,
                "--dport",
                &port_s,
                "-j",
                "ACCEPT",
            ],
        )?;
    } else if allow_any_remote {
        linux_run_cmd(
            "iptables",
            &["-A", "STELLAR_KILLSWITCH", "-p", &p, "--dport", &port_s, "-j", "ACCEPT"],
        )?;
    }

    // default drop
    linux_run_cmd("iptables", &["-A", "STELLAR_KILLSWITCH", "-j", "DROP"])?;

    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_killswitch_apply(
    state_arc: &Arc<Mutex<VpnInner>>,
    proto: &str,
    port: u16,
    remote_ip: Option<&str>,
    allow_any_remote: bool,
) -> Result<(), String> {
    if !linux_is_root() {
        return Err("Kill switch on Linux requires root (sudo) until we ship a privileged helper.".to_string());
    }

    // Remember last settings
    {
        if let Ok(mut g) = state_arc.lock() {
            g.last_proto = proto.to_string();
            g.last_port = port;
            if let Some(ip) = remote_ip {
                g.last_remote_ip = Some(ip.to_string());
            }
        }
    }

    if linux_cmd_exists("nft") {
        linux_killswitch_apply_nft(proto, port, remote_ip, allow_any_remote)
    } else {
        linux_killswitch_apply_iptables(proto, port, remote_ip, allow_any_remote)
    }
}

// ----------------- process/pid helpers -----------------
#[cfg(unix)]
fn unix_pid_alive(pid: u32) -> bool {
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

#[cfg(not(unix))]
fn unix_pid_alive(_pid: u32) -> bool {
    false
}

fn read_pid_file(pid_path: &Path) -> Option<u32> {
    let s = fs::read_to_string(pid_path).ok()?;
    s.trim().parse::<u32>().ok()
}

// ----------------- log tailer + watchdog -----------------

fn start_log_file_tailer(
    app: tauri::AppHandle,
    state_arc: Arc<Mutex<VpnInner>>,
    log_path: PathBuf,
    session_id: u64,
) {
    std::thread::spawn(move || {
        let mut pos: u64 = 0;
        let mut carry = String::new();
        let mut tightened = false;

        loop {
            if !session_is_active(&state_arc, session_id) {
                return;
            }

            let mut file = match fs::OpenOptions::new().read(true).open(&log_path) {
                Ok(f) => f,
                Err(_) => {
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            };

            if file.seek(SeekFrom::Start(pos)).is_err() {
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }

            let mut chunk = String::new();
            if file.read_to_string(&mut chunk).is_ok() {
                if let Ok(new_pos) = file.stream_position() {
                    pos = new_pos;
                }

                if !chunk.is_empty() {
                    // mark progress for watchdog
                    if let Ok(mut g) = state_arc.lock() {
                        g.last_log_at_ms = now_ms();
                        g.last_log_pos = pos;
                    }

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

                        // Learn remote ip and tighten kill switch once
                        if !tightened
                            && (line.contains("UDP link remote:")
                                || line.contains("Preserving recently used remote address:")
                                || line.contains("TCP/UDP: Preserving recently used remote address:"))
                        {
                            if let Some((ip, port)) = extract_remote_ip_from_log_line(line) {
                                let ks_on = state_arc.lock().map(|g| g.killswitch_enabled).unwrap_or(false);

                                {
                                    if let Ok(mut g) = state_arc.lock() {
                                        g.last_remote_ip = Some(ip.clone());
                                        g.last_port = port;
                                    }
                                }

                                #[cfg(target_os = "linux")]
                                {
                                    if ks_on {
                                        let proto = state_arc.lock().map(|g| g.last_proto.clone()).unwrap_or("udp".to_string());
                                        let _ = linux_killswitch_apply(&state_arc, &proto, port, Some(&ip), false);
                                        tightened = true;
                                    }
                                }
                            }
                        }

                        if line.contains("Initialization Sequence Completed") {
                            set_status(&state_arc, &app, "connected");

                            #[cfg(target_os = "linux")]
                            {
                                let (ks_on, proto, port, rip) = {
                                    let g = match state_arc.lock() {
                                        Ok(x) => x,
                                        Err(_) => continue,
                                    };
                                    (
                                        g.killswitch_enabled,
                                        g.last_proto.clone(),
                                        g.last_port,
                                        g.last_remote_ip.clone(),
                                    )
                                };

                                if ks_on {
                                    let _ = linux_killswitch_apply(&state_arc, &proto, port, rip.as_deref(), false);
                                }
                            }
                        }

                        if line.contains("AUTH_FAILED") {
                            let _ = app.emit("vpn-log", "[fatal] AUTH_FAILED".to_string());
                            set_status(&state_arc, &app, "disconnected");
                        }
                    }

                    carry = last_incomplete.unwrap_or_default();
                }
            }

            std::thread::sleep(Duration::from_millis(200));
        }
    });
}

fn watchdog_abort_connect(
    app: &tauri::AppHandle,
    state_arc: &Arc<Mutex<VpnInner>>,
    reason: &str,
    log_path: &Path,
) {
    let _ = app.emit("vpn-status", format!("error: {reason}"));
    let _ = app.emit("vpn-log", format!("[watchdog] abort: {reason}"));

    let last = tail_last_lines(log_path, 80);
    if !last.is_empty() {
        let _ = app.emit("vpn-log", "[watchdog] last log lines:".to_string());
        for line in last {
            let _ = app.emit("vpn-log", line);
        }
    } else {
        let _ = app.emit("vpn-log", "[watchdog] no log lines available".to_string());
    }

    // cleanup + kill
    let (mut child_opt, auth_path, pid_path, pid, ks_on, proto, port, rip, crash_recovery_enabled) = {
        let mut g = match state_arc.lock() {
            Ok(x) => x,
            Err(_) => return,
        };

        // stop tailers/watchers
        g.session_id = g.session_id.saturating_add(1);

        let child = g.process.take();
        let auth = g.auth_path.take();
        let pid_path = g.pid_path.take();
        let pid = g.pid.take();

        g.status = "disconnected".to_string();

        (
            child,
            auth,
            pid_path,
            pid,
            g.killswitch_enabled,
            g.last_proto.clone(),
            g.last_port,
            g.last_remote_ip.clone(),
            g.crash_recovery_enabled,
        )
    };

    if let Some(mut child) = child_opt.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
        }
    }

    if let Some(p) = auth_path {
        let _ = fs::remove_file(p);
    }
    if let Some(p) = pid_path {
        let _ = fs::remove_file(p);
    }

    if crash_recovery_enabled {
        clear_session_file(app);
    } else {
        clear_session_file(app);
    }

    let _ = app.emit("vpn-status", "disconnected".to_string());

    // Always-on behavior while enabled: keep kill switch active in disconnected state
    #[cfg(target_os = "linux")]
    {
        if ks_on {
            let _ = linux_killswitch_apply(state_arc, &proto, port, rip.as_deref(), rip.is_none());
            let _ = app.emit("vpn-log", "[killswitch] active (disconnected state)".to_string());
        }
    }
}

fn start_connect_watchdog(
    app: tauri::AppHandle,
    state_arc: Arc<Mutex<VpnInner>>,
    log_path: PathBuf,
    session_id: u64,
) {
    std::thread::spawn(move || {
        let deadline = now_ms().saturating_add(CONNECT_STUCK_SECS * 1000);

        loop {
            std::thread::sleep(Duration::from_millis(250));

            if !session_is_active(&state_arc, session_id) {
                return;
            }

            let (status, last_log_at) = match state_arc.lock() {
                Ok(g) => (g.status.clone(), g.last_log_at_ms),
                Err(_) => return,
            };

            if status != "connecting" {
                return;
            }

            if now_ms() < deadline {
                continue;
            }

            let idle_ms = now_ms().saturating_sub(last_log_at);
            if idle_ms >= CONNECT_STUCK_IDLE_GRACE_MS {
                watchdog_abort_connect(
                    &app,
                    &state_arc,
                    "timeout (no progress while connecting)",
                    &log_path,
                );
                return;
            }
        }
    });
}

// ----------------- tauri commands -----------------

#[tauri::command]
fn vpn_status(state: State<'_, VpnState>) -> String {
    state
        .inner
        .lock()
        .map(|g| g.status.clone())
        .unwrap_or_else(|_| "disconnected".to_string())
}

#[tauri::command]
fn killswitch_status(state: State<'_, VpnState>) -> bool {
    state.inner.lock().map(|g| g.killswitch_enabled).unwrap_or(false)
}

#[tauri::command(rename_all = "camelCase")]
fn killswitch_set(
    state: State<'_, VpnState>,
    app: tauri::AppHandle,
    enabled: bool,
    config_path: Option<String>,
    bearer_token: Option<String>,
) -> Result<(), String> {
    // Persist pref
    {
        let mut g = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
        g.killswitch_enabled = enabled;
    }

    let pf = {
        let g = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
        PrefsFile {
            killswitch_enabled: g.killswitch_enabled,
            crash_recovery_enabled: g.crash_recovery_enabled,
        }
    };
    let _ = save_prefs(&app, &pf);

    #[cfg(target_os = "linux")]
    {
        if !enabled {
            linux_killswitch_disable()?;
            let _ = app.emit("vpn-log", "[killswitch] disabled".to_string());
            return Ok(());
        }

        // When enabling while disconnected, try to parse config to know proto/port.
        // If not provided, we fall back to remembered values.
        let mut proto = "udp".to_string();
        let mut port: u16 = 1194;
        let mut seeded_remote_ip: Option<String> = None;

        if let Some(cp) = config_path.clone() {
            let resolved = if is_http_url(&cp) {
                download_config_to_app_data(&app, &cp, bearer_token.as_deref())?
            } else {
                PathBuf::from(cp)
            };

            if resolved.exists() {
                let cfg_contents = fs::read_to_string(&resolved).unwrap_or_default();
                let (p, po) = parse_ovpn_proto_port(&cfg_contents);
                proto = p;
                port = po;

                // seed remote ip best-effort
                for raw in cfg_contents.lines() {
                    let line = raw.trim();
                    if line.starts_with("remote ") {
                        let mut parts = line.split_whitespace();
                        let _ = parts.next();
                        if let Some(host) = parts.next() {
                            let p = parts
                                .next()
                                .and_then(|x| x.parse::<u16>().ok())
                                .unwrap_or(port);

                            seeded_remote_ip = resolve_host_to_ip(host, p);
                            break;
                        }
                    }
                }
            }
        } else {
            let g = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
            proto = g.last_proto.clone();
            port = g.last_port;
            seeded_remote_ip = g.last_remote_ip.clone();
        }

        // Apply baseline: allow proto/port to remote if known, else allow-any for handshake.
        linux_killswitch_apply(&state.inner, &proto, port, seeded_remote_ip.as_deref(), seeded_remote_ip.is_none())?;
        let _ = app.emit("vpn-log", format!("[killswitch] enabled ({}:{})", proto, port));
    }

    Ok(())
}

#[tauri::command]
fn crashrecovery_status(state: State<'_, VpnState>) -> bool {
    state
        .inner
        .lock()
        .map(|g| g.crash_recovery_enabled)
        .unwrap_or(true)
}

#[tauri::command(rename_all = "camelCase")]
fn crashrecovery_set(
    state: State<'_, VpnState>,
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<(), String> {
    {
        let mut g = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
        g.crash_recovery_enabled = enabled;
    }

    let pf = {
        let g = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
        PrefsFile {
            killswitch_enabled: g.killswitch_enabled,
            crash_recovery_enabled: g.crash_recovery_enabled,
        }
    };
    let _ = save_prefs(&app, &pf);

    if !enabled {
        clear_session_file(&app);
        let _ = app.emit("vpn-log", "[crash-recovery] disabled".to_string());
    } else {
        let _ = app.emit("vpn-log", "[crash-recovery] enabled".to_string());
    }

    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn vpn_disconnect(state: State<'_, VpnState>, app: tauri::AppHandle) -> Result<(), String> {
    let (mut child_opt, auth_path, pid_path, pid, ks_on, proto, port, rip) = {
        let mut guard = state.inner.lock().map_err(|_| "State lock poisoned".to_string())?;
        guard.session_id = guard.session_id.saturating_add(1);

        let child = guard.process.take();
        let auth = guard.auth_path.take();
        let pid_path = guard.pid_path.take();
        let pid = guard.pid.take();

        guard.status = "disconnected".to_string();
        guard.log_path = None;
        guard.status_path = None;

        (
            child,
            auth,
            pid_path,
            pid,
            guard.killswitch_enabled,
            guard.last_proto.clone(),
            guard.last_port,
            guard.last_remote_ip.clone(),
        )
    };

    if let Some(mut child) = child_opt.take() {
        let _ = child.kill();
        let _ = child.wait();
    }

    if let Some(pid) = pid {
        #[cfg(unix)]
        {
            let _ = Command::new("kill").arg("-TERM").arg(pid.to_string()).status();
        }
    }

    if let Some(p) = auth_path {
        let _ = fs::remove_file(p);
    }

    if let Some(p) = pid_path {
        let _ = fs::remove_file(p);
    }

    clear_session_file(&app);
    set_status(&state.inner, &app, "disconnected");

    // Always-on behavior while enabled: keep kill switch active in disconnected state
    #[cfg(target_os = "linux")]
    {
        if ks_on {
            linux_killswitch_apply(&state.inner, &proto, port, rip.as_deref(), rip.is_none())?;
            let _ = app.emit("vpn-log", "[killswitch] active (disconnected state)".to_string());
        } else {
            let _ = linux_killswitch_disable();
        }
    }

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

    // Prevent double-connect + new session
    let session_id = {
        let mut guard = state_arc.lock().map_err(|_| "State lock poisoned".to_string())?;

        if guard.process.is_some() {
            return Err("VPN already running".into());
        }

        if let Some(pid) = guard.pid {
            #[cfg(unix)]
            {
                if unix_pid_alive(pid) {
                    return Err("VPN already running (recovered pid)".into());
                }
            }
        }

        guard.session_id = guard.session_id.saturating_add(1);
        let sid = guard.session_id;

        guard.status = "connecting".to_string();
        guard.auth_path = None;
        guard.log_path = None;
        guard.status_path = None;
        guard.pid_path = None;
        guard.pid = None;

        let t = now_ms();
        guard.connect_started_at_ms = t;
        guard.last_log_at_ms = t;
        guard.last_log_pos = 0;

        sid
    };

    let _ = app.emit("vpn-status", "connecting".to_string());

    // Resolve config path
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

    // Parse proto/port from config (best-effort)
    let cfg_contents = fs::read_to_string(&resolved_config_path).unwrap_or_default();
    let (proto, port) = parse_ovpn_proto_port(&cfg_contents);

    // Seed remote ip best-effort
    let mut seeded_remote_ip: Option<String> = None;
    for raw in cfg_contents.lines() {
        let line = raw.trim();
        if line.starts_with("remote ") {
            let mut parts = line.split_whitespace();
            let _ = parts.next();
            if let Some(host) = parts.next() {
                let p = parts
                    .next()
                    .and_then(|x| x.parse::<u16>().ok())
                    .unwrap_or(port);

                seeded_remote_ip = resolve_host_to_ip(host, p);
                break;
            }
        }
    }

    // Auth file (optional)
    let auth_path = match (username.as_deref(), password.as_deref()) {
        (Some(u), Some(p)) if !u.trim().is_empty() && !p.trim().is_empty() => {
            Some(create_auth_file(&app, u.trim(), p.trim())?)
        }
        _ => None,
    };

    // Runtime files
    let (log_path, status_path, pid_path) = create_runtime_files(&app)?;

    #[cfg(unix)]
    unsafe {
        libc::umask(0o077);
    }

    // Apply kill switch BEFORE connect (if enabled)
    #[cfg(target_os = "linux")]
    {
        let ks_on = state_arc.lock().map(|g| g.killswitch_enabled).unwrap_or(false);

        if ks_on {
            let allow_any = seeded_remote_ip.is_none();
            linux_killswitch_apply(
                &state_arc,
                &proto,
                port,
                seeded_remote_ip.as_deref(),
                allow_any,
            )?;
            let _ = app.emit("vpn-log", format!("[killswitch] enabled ({}:{})", proto, port));
        }
    }

    let mut cmd = Command::new(openvpn_path);
    cmd.arg("--config").arg(&resolved_config_path);

    #[cfg(target_os = "linux")]
    {
        cmd.arg("--dev").arg(TUN_IFNAME);
        cmd.arg("--dev-type").arg("tun");
    }

    if let Some(ap) = &auth_path {
        cmd.arg("--auth-user-pass").arg(ap);
        cmd.arg("--auth-nocache");
    }

    cmd.arg("--log-append").arg(&log_path);
    cmd.arg("--status").arg(&status_path).arg("1");
    cmd.arg("--writepid").arg(&pid_path);
    cmd.arg("--verb").arg("6");

    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());

    let child = cmd.spawn().map_err(|e| {
        if let Some(p) = &auth_path {
            let _ = fs::remove_file(p);
        }
        format!("Failed to start OpenVPN: {e}")
    })?;

    // Read pid (best-effort)
    let mut pid: Option<u32> = None;
    for _ in 0..10 {
        pid = read_pid_file(&pid_path);
        if pid.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(80));
    }

    let crash_recovery_enabled = state_arc.lock().map(|g| g.crash_recovery_enabled).unwrap_or(true);

    {
        let mut guard = state_arc.lock().map_err(|_| "State lock poisoned".to_string())?;
        guard.process = Some(child);
        guard.auth_path = auth_path;
        guard.log_path = Some(log_path.clone());
        guard.status_path = Some(status_path.clone());
        guard.pid_path = Some(pid_path.clone());
        guard.pid = pid;
        guard.last_proto = proto.clone();
        guard.last_port = port;
        guard.last_remote_ip = seeded_remote_ip.clone();
    }

    // Persist crash recovery only if enabled
    if crash_recovery_enabled {
        if let Some(pid) = pid {
            let sf = SessionFile {
                pid,
                log_path: log_path.display().to_string(),
                status_path: status_path.display().to_string(),
                pid_path: pid_path.display().to_string(),
                last_proto: proto.clone(),
                last_port: port,
                last_remote_ip: seeded_remote_ip.clone(),
                killswitch_enabled: state_arc.lock().map(|g| g.killswitch_enabled).unwrap_or(false),
                crash_recovery_enabled,
            };
            let _ = save_session_file(&app, &sf);
        }
    } else {
        clear_session_file(&app);
    }

    let _ = app.emit("vpn-log", format!("OpenVPN log file: {}", log_path.display()));
    let _ = app.emit("vpn-log", format!("OpenVPN status file: {}", status_path.display()));
    let _ = app.emit("vpn-log", format!("OpenVPN pid file: {}", pid_path.display()));

    // Tail logs + watchdog
    start_log_file_tailer(app.clone(), state_arc.clone(), log_path.clone(), session_id);
    start_connect_watchdog(app.clone(), state_arc.clone(), log_path.clone(), session_id);

    // watcher thread (child exit)
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
                    guard.pid = None;
                    guard.status = "disconnected".to_string();
                    let _ = app_clone.emit("vpn-status", "disconnected".to_string());
                    break;
                }
                Ok(None) => {}
                Err(e) => {
                    guard.process = None;
                    guard.pid = None;
                    guard.status = format!("error: {e}");
                    let _ = app_clone.emit("vpn-status", guard.status.clone());
                    break;
                }
            }
        });
    }

    Ok(())
}

fn recover_on_startup(app: &tauri::AppHandle, state_arc: Arc<Mutex<VpnInner>>) {
    let sf = match load_session_file(app) {
        Ok(Some(v)) => v,
        _ => return,
    };

    if !sf.crash_recovery_enabled {
        clear_session_file(app);
        let _ = app.emit("vpn-log", "[recovery] disabled by prefs".to_string());
        return;
    }

    #[cfg(unix)]
    {
        if !unix_pid_alive(sf.pid) {
            clear_session_file(app);
            let _ = app.emit("vpn-log", "[recovery] stale session cleared".to_string());
            return;
        }
    }

    {
        let mut g = match state_arc.lock() {
            Ok(x) => x,
            Err(_) => return,
        };

        g.process = None;
        g.pid = Some(sf.pid);
        g.log_path = Some(PathBuf::from(sf.log_path.clone()));
        g.status_path = Some(PathBuf::from(sf.status_path.clone()));
        g.pid_path = Some(PathBuf::from(sf.pid_path.clone()));
        g.status = "connecting".to_string(); // tailer will upgrade to connected
        g.killswitch_enabled = sf.killswitch_enabled;
        g.crash_recovery_enabled = sf.crash_recovery_enabled;
        g.last_proto = sf.last_proto.clone();
        g.last_port = sf.last_port;
        g.last_remote_ip = sf.last_remote_ip.clone();
        g.session_id = g.session_id.saturating_add(1);

        let t = now_ms();
        g.connect_started_at_ms = t;
        g.last_log_at_ms = t;
        g.last_log_pos = 0;
    }

    let _ = app.emit("vpn-status", "connecting".to_string());
    let _ = app.emit("vpn-log", format!("[recovery] openvpn pid {} still running", sf.pid));

    #[cfg(target_os = "linux")]
    {
        if sf.killswitch_enabled {
            let allow_any = sf.last_remote_ip.is_none();
            let _ = linux_killswitch_apply(
                &state_arc,
                &sf.last_proto,
                sf.last_port,
                sf.last_remote_ip.as_deref(),
                allow_any,
            );
        }
    }

    // Restart log tailer
    let sid = state_arc.lock().map(|g| g.session_id).unwrap_or(0);
let log_path = PathBuf::from(sf.log_path.clone());

start_log_file_tailer(app.clone(), state_arc.clone(), log_path.clone(), sid);
start_connect_watchdog(app.clone(), state_arc, log_path, sid);
}

fn main() {
    let _ = fix_path_env::fix();

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(VpnState::new())
        .setup(|app| {
            // Load prefs into state
            if let Ok(Some(pf)) = load_prefs(&app.handle()) {
                if let Ok(mut g) = app.state::<VpnState>().inner.lock() {
                    g.killswitch_enabled = pf.killswitch_enabled;
                    g.crash_recovery_enabled = pf.crash_recovery_enabled;
                }
            }

            // Crash recovery
            let state: State<VpnState> = app.state();
            recover_on_startup(&app.handle(), state.inner.clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            vpn_connect,
            vpn_disconnect,
            vpn_status,
            killswitch_set,
            killswitch_status,
            crashrecovery_set,
            crashrecovery_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
