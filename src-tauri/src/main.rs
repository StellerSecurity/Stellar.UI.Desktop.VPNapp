#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  fs,
  io::{Read, Seek, SeekFrom},
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

// You said “we test with openvpn directly”. Fine.
// At least don’t turn your desktop app into an SSRF cannon.
const CONFIG_HOST_ALLOWLIST: [&str; 1] = ["stellarvpnserverstorage.blob.core.windows.net"];

struct VpnInner {
  process: Option<Child>,
  status: String, // "disconnected" | "connecting" | "connected" | "error: ..."
  temp_config_path: Option<PathBuf>,
  temp_auth_path: Option<PathBuf>,
  log_path: Option<PathBuf>,
  status_path: Option<PathBuf>,
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
        temp_config_path: None,
        temp_auth_path: None,
        log_path: None,
        status_path: None,
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

fn create_private_dir(path: &Path) -> Result<(), String> {
  fs::create_dir_all(path).map_err(|e| format!("Failed to create dir: {e}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
      .map_err(|e| format!("Failed to set dir permissions: {e}"))?;
  }

  Ok(())
}

fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
  fs::write(path, bytes).map_err(|e| format!("Failed to write file: {e}"))?;

  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
      .map_err(|e| format!("Failed to set file permissions: {e}"))?;
  }

  Ok(())
}

fn remove_file_best_effort(p: Option<PathBuf>) {
  if let Some(path) = p {
    let _ = fs::remove_file(path);
  }
}

fn stamp_nanos() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_nanos()
}

fn set_status(state_arc: &Arc<Mutex<VpnInner>>, app: &tauri::AppHandle, status: &str) {
  if let Ok(mut g) = state_arc.lock() {
    g.status = status.to_string();
  }
  let _ = app.emit("vpn-status", status);
}

fn ensure_log_files(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;

  let dir = app_data_dir.join("vpn").join("logs");
  create_private_dir(&dir)?;

  let stamp = stamp_nanos();
  let log_path = dir.join(format!("openvpn-{stamp}.log"));
  let status_path = dir.join(format!("openvpn-{stamp}.status.txt"));

  write_private_file(&log_path, b"")?;
  write_private_file(&status_path, b"")?;

  Ok((log_path, status_path))
}

fn download_config_to_app_data(
  app: &tauri::AppHandle,
  config_url: &str,
) -> Result<PathBuf, String> {
  let url = Url::parse(config_url).map_err(|e| format!("Invalid config URL: {e}"))?;

  if url.scheme() != "https" {
    return Err("Config URL must be https".to_string());
  }

  let host = url.host_str().unwrap_or("");
  if !CONFIG_HOST_ALLOWLIST.iter().any(|h| h.eq_ignore_ascii_case(host)) {
    return Err(format!("Config host not allowed: {host}"));
  }

  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;

  let dir = app_data_dir.join("vpn").join("configs");
  create_private_dir(&dir)?;

  let hash = hex::encode(Sha256::digest(config_url.as_bytes()));
  let path = dir.join(format!("{hash}.ovpn"));

  let client = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(20))
    .build()
    .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

  let resp = client
    .get(config_url)
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

fn create_auth_file(app: &tauri::AppHandle, username: &str, password: &str) -> Result<PathBuf, String> {
  let app_data_dir = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("Failed to resolve app_data_dir: {e}"))?;

  let dir = app_data_dir.join("vpn").join("auth");
  create_private_dir(&dir)?;

  let path = dir.join(format!("auth-{}.txt", stamp_nanos()));
  let content = format!("{}\n{}\n", username, password);
  write_private_file(&path, content.as_bytes())?;
  Ok(path)
}

// Tails a file by polling (portable, simple, and good enough for dev).
fn tail_file_emit(app: tauri::AppHandle, state_arc: Arc<Mutex<VpnInner>>, path: PathBuf) {
  std::thread::spawn(move || {
    let mut pos: u64 = 0;

    loop {
      // Stop tailing if we no longer have a running process (avoids zombie threads).
      let running = {
        if let Ok(g) = state_arc.lock() {
          g.process.is_some()
        } else {
          false
        }
      };
      if !running {
        break;
      }

      let mut f = match fs::File::open(&path) {
        Ok(f) => f,
        Err(_) => {
          std::thread::sleep(Duration::from_millis(250));
          continue;
        }
      };

      // If file shrank (rotation), reset.
      if let Ok(meta) = f.metadata() {
        if meta.len() < pos {
          pos = 0;
        }
      }

      if f.seek(SeekFrom::Start(pos)).is_err() {
        std::thread::sleep(Duration::from_millis(250));
        continue;
      }

      let mut buf = String::new();
      if f.read_to_string(&mut buf).is_ok() && !buf.is_empty() {
        pos = pos.saturating_add(buf.as_bytes().len() as u64);

        for line in buf.lines() {
          // Emit to UI + print to terminal (so you can debug even if frontend is being dramatic).
          let _ = app.emit("vpn-log", line.to_string());
          println!("[VPN] {}", line);

          if line.contains("Initialization Sequence Completed") {
            set_status(&state_arc, &app, "connected");
          }

          if line.contains("AUTH_FAILED") {
            let _ = app.emit("vpn-log", "[fatal] AUTH_FAILED".to_string());
            set_status(&state_arc, &app, "disconnected");
          }
        }
      }

      std::thread::sleep(Duration::from_millis(250));
    }
  });
}

#[tauri::command]
fn vpn_status(state: State<'_, VpnState>) -> String {
  state.inner.lock().unwrap().status.clone()
}

#[tauri::command]
fn vpn_get_log_tail(state: State<'_, VpnState>, lines: Option<usize>) -> Result<String, String> {
  let n = lines.unwrap_or(200).min(2000);

  let path = {
    let g = state.inner.lock().unwrap();
    g.log_path.clone().ok_or("No log file yet")?
  };

  let content = fs::read_to_string(&path).map_err(|e| format!("Failed to read log file: {e}"))?;
  let mut v: Vec<&str> = content.lines().collect();
  if v.len() > n {
    v = v.split_off(v.len() - n);
  }
  Ok(v.join("\n"))
}

#[tauri::command]
fn vpn_disconnect(state: State<'_, VpnState>, app: tauri::AppHandle) -> Result<(), String> {
  let (mut child, cfg, auth) = {
    let mut guard = state.inner.lock().unwrap();
    (
      guard.process.take(),
      guard.temp_config_path.take(),
      guard.temp_auth_path.take(),
    )
  };

  if let Some(mut c) = child.take() {
    let _ = c.kill();
    let _ = c.wait();
  }

  // Keep logs for debugging. Delete only sensitive temp files.
  remove_file_best_effort(cfg);
  remove_file_best_effort(auth);

  set_status(&state.inner, &app, "disconnected");
  Ok(())
}

#[tauri::command]
fn vpn_connect(
  window: tauri::Window,
  state: State<'_, VpnState>,
  config_path: Option<String>,  // URL or local path, optional
  username: Option<String>,     // optional
  password: Option<String>,     // optional
) -> Result<(), String> {
  let app = window.app_handle();
  let state_arc = state.inner.clone();

  // Prevent double-connect
  {
    let mut guard = state_arc.lock().unwrap();
    if guard.process.is_some() {
      return Err("VPN already running".into());
    }
    guard.status = "connecting".to_string();
    guard.temp_config_path = None;
    guard.temp_auth_path = None;
    guard.log_path = None;
    guard.status_path = None;
  }
  let _ = app.emit("vpn-status", "connecting");

  let cfg_input = config_path
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| DEFAULT_OVPN_URL.to_string());

  // Create log + status files
  let (log_path, status_path) = ensure_log_files(&app)?;

  // Resolve config
  let (resolved_config_path, downloaded_temp) = if is_http_url(&cfg_input) {
    let p = download_config_to_app_data(&app, &cfg_input)?;
    (p.clone(), Some(p))
  } else {
    (PathBuf::from(&cfg_input), None)
  };

  if !resolved_config_path.exists() {
    set_status(&state_arc, &app, "disconnected");
    return Err(format!("Config file does not exist: {}", resolved_config_path.display()));
  }

  let openvpn_path = locate_openvpn().ok_or("OpenVPN binary not found")?;

  // Auth file if both are present
  let auth_path: Option<PathBuf> = match (username.as_deref(), password.as_deref()) {
    (Some(u), Some(p)) if !u.is_empty() && !p.is_empty() => Some(create_auth_file(&app, u, p)?),
    _ => None,
  };

  // Build OpenVPN command
  let mut cmd = Command::new(openvpn_path);

  cmd.arg("--config").arg(&resolved_config_path);

  if let Some(ap) = &auth_path {
    cmd.arg("--auth-user-pass").arg(ap);
    cmd.arg("--auth-nocache");
  }

  cmd.arg("--verb").arg("6");
  cmd.arg("--log-append").arg(&log_path);
  cmd.arg("--status").arg(&status_path).arg("1");

  // We still pipe stdio, but on many setups OpenVPN logs go to file.
  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  let child = match cmd.spawn() {
    Ok(c) => c,
    Err(e) => {
      remove_file_best_effort(downloaded_temp);
      remove_file_best_effort(auth_path);
      set_status(&state_arc, &app, "disconnected");
      return Err(format!("Failed to start OpenVPN: {e}"));
    }
  };

  {
    let mut guard = state_arc.lock().unwrap();
    guard.process = Some(child);
    guard.status = "connecting".to_string();
    guard.temp_config_path = downloaded_temp;
    guard.temp_auth_path = auth_path;
    guard.log_path = Some(log_path.clone());
    guard.status_path = Some(status_path.clone());
  }

  // Tail the log file and emit lines to frontend (this is what you were missing).
  tail_file_emit(app.clone(), state_arc.clone(), log_path);

  // Watcher: detect process exit and update status; cleanup only sensitive temp files.
  {
    let app_clone = app.clone();
    let state_clone = state_arc.clone();
    std::thread::spawn(move || loop {
      std::thread::sleep(Duration::from_millis(500));

      let mut guard = match state_clone.lock() {
        Ok(g) => g,
        Err(_) => break,
      };

      let Some(child) = guard.process.as_mut() else {
        break;
      };

      match child.try_wait() {
        Ok(Some(_)) => {
          guard.process = None;
          guard.status = "disconnected".to_string();
          let cfg = guard.temp_config_path.take();
          let auth = guard.temp_auth_path.take();
          drop(guard);

          remove_file_best_effort(cfg);
          remove_file_best_effort(auth);

          let _ = app_clone.emit("vpn-status", "disconnected");
          break;
        }
        Ok(None) => {}
        Err(e) => {
          guard.process = None;
          guard.status = format!("error: {e}");
          let cfg = guard.temp_config_path.take();
          let auth = guard.temp_auth_path.take();
          drop(guard);

          remove_file_best_effort(cfg);
          remove_file_best_effort(auth);

          let _ = app_clone.emit("vpn-status", format!("error: {e}"));
          break;
        }
      }
    });
  }

  Ok(())
}

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_store::Builder::new().build())
    .manage(VpnState::new())
    .invoke_handler(tauri::generate_handler![
      vpn_connect,
      vpn_disconnect,
      vpn_status,
      vpn_get_log_tail
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
