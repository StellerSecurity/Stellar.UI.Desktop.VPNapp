// src-tauri/src/macos_helper.rs
#![cfg(target_os = "macos")]

use std::{
  fs,
  io::{Read, Seek, SeekFrom},
  path::{Path, PathBuf},
  process::Command,
  thread,
  time::Duration,
};

use once_cell::sync::Lazy;
use tauri::AppHandle;

use super::{emit_log, set_status, set_error_and_disconnect, SharedState, UiStatus, RT};

static OPENVPN_PID: Lazy<std::sync::Mutex<Option<u32>>> = Lazy::new(|| std::sync::Mutex::new(None));
static OPENVPN_LOG: Lazy<std::sync::Mutex<Option<PathBuf>>> = Lazy::new(|| std::sync::Mutex::new(None));
static OPENVPN_PIDFILE: Lazy<std::sync::Mutex<Option<PathBuf>>> = Lazy::new(|| std::sync::Mutex::new(None));
static OPENVPN_LOG_POS: Lazy<std::sync::Mutex<u64>> = Lazy::new(|| std::sync::Mutex::new(0));
static OPENVPN_START_MS: Lazy<std::sync::Mutex<Option<u64>>> = Lazy::new(|| std::sync::Mutex::new(None));

fn escape_applescript(s: &str) -> String {
  s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn run_applescript_admin(shell_cmd: &str) -> Result<(), String> {
  let cmd_escaped = escape_applescript(shell_cmd);
  let script = format!(
    "do shell script \"{}\" with administrator privileges",
    cmd_escaped
  );

  let out = Command::new("osascript")
    .arg("-e")
    .arg(script)
    .output()
    .map_err(|e| format!("Failed to run osascript: {e}"))?;

  if out.status.success() {
    Ok(())
  } else {
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Err(if stderr.trim().is_empty() {
      "osascript failed (no stderr)".to_string()
    } else {
      format!("osascript failed: {}", stderr.trim())
    })
  }
}

fn ensure_parent_dir(p: &Path) -> Result<(), String> {
  if let Some(parent) = p.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir {}: {e}", parent.display()))?;
  }
  Ok(())
}

fn make_log_path() -> PathBuf {
  super::temp_dir().join(format!("openvpn-macos-{}.log", super::now_ms()))
}

fn make_pid_path() -> PathBuf {
  super::temp_dir().join(format!("openvpn-macos-{}.pid", super::now_ms()))
}

fn read_pid(pid_path: &Path) -> Option<u32> {
  let s = fs::read_to_string(pid_path).ok()?;
  s.trim().parse::<u32>().ok()
}

fn pid_alive(pid: u32) -> bool {
  // ps -p PID returnerer 0 hvis processen findes
  match Command::new("ps").arg("-p").arg(pid.to_string()).output() {
    Ok(o) => o.status.success(),
    Err(_) => false,
  }
}

fn tail_last_bytes(path: &Path, max_bytes: usize) -> String {
  let mut f = match fs::File::open(path) {
    Ok(f) => f,
    Err(_) => return "".to_string(),
  };
  let len = f.metadata().map(|m| m.len()).unwrap_or(0);
  let start = len.saturating_sub(max_bytes as u64);

  if f.seek(SeekFrom::Start(start)).is_err() {
    return "".to_string();
  }
  let mut buf = Vec::new();
  let _ = f.read_to_end(&mut buf);
  String::from_utf8_lossy(&buf).to_string()
}

pub async fn helper_connect(
  app: &AppHandle<RT>,
  state: &SharedState,
  openvpn_bin: PathBuf,
  cfg_path: PathBuf,
  auth_path: PathBuf,
) -> Result<(), String> {
  emit_log(app, "[macos] helper_connect called");

  let log_path = make_log_path();
  let pid_path = make_pid_path();

  ensure_parent_dir(&log_path)?;
  ensure_parent_dir(&pid_path)?;

  // Pre-create files so your user can read them even if root writes later
  let _ = fs::write(&log_path, b"");
  let _ = fs::write(&pid_path, b"");

  // OpenVPN as a daemon with explicit log + pidfile (stable)
  let ovpn = openvpn_bin.to_string_lossy();
  let cfg = cfg_path.to_string_lossy();
  let auth = auth_path.to_string_lossy();
  let log = log_path.to_string_lossy();
  let pidf = pid_path.to_string_lossy();

  // Use --daemon + --writepid + --log (no nohup voodoo)
  let shell_cmd = format!(
    "'{}' --config '{}' --auth-user-pass '{}' --auth-nocache --redirect-gateway def1 --verb 3 --log '{}' --writepid '{}' --daemon",
    ovpn, cfg, auth, log, pidf
  );

  emit_log(app, &format!("[macos] Starting OpenVPN via admin prompt."));
  emit_log(app, &format!("[macos] Log: {}", log));
  emit_log(app, &format!("[macos] Pidfile: {}", pidf));

  run_applescript_admin(&shell_cmd)?;

  // Wait briefly for pidfile to populate
  let mut pid: Option<u32> = None;
  for _ in 0..30 {
    pid = read_pid(&pid_path);
    if pid.is_some() {
      break;
    }
    std::thread::sleep(Duration::from_millis(50));
  }

  let Some(pid) = pid else {
    let tail = tail_last_bytes(&log_path, 12_000);
    let msg = if tail.trim().is_empty() {
      "OpenVPN startede ikke (ingen PID i pidfile). Tjek log.".to_string()
    } else {
      format!("OpenVPN startede ikke (ingen PID i pidfile). Log:\n{tail}")
    };
    set_error_and_disconnect(state, app, msg).await;
    return Err("OpenVPN did not write pidfile".to_string());
  };

  {
    *OPENVPN_PID.lock().unwrap() = Some(pid);
    *OPENVPN_LOG.lock().unwrap() = Some(log_path.clone());
    *OPENVPN_PIDFILE.lock().unwrap() = Some(pid_path.clone());
    *OPENVPN_LOG_POS.lock().unwrap() = 0;
    *OPENVPN_START_MS.lock().unwrap() = Some(super::now_ms());
  }

  emit_log(app, &format!("[macos] OpenVPN daemon started (pid={pid})"));

  // If it already died, fail fast with log tail
  if !pid_alive(pid) {
    let tail = tail_last_bytes(&log_path, 12_000);
    let msg = if tail.trim().is_empty() {
      "OpenVPN døde med det samme på macOS. (Ingen log-output)".to_string()
    } else {
      format!("OpenVPN døde med det samme på macOS. Log:\n{tail}")
    };
    set_error_and_disconnect(state, app, msg).await;
    return Err("OpenVPN exited immediately".to_string());
  }

  set_status(state, app, UiStatus::Connecting).await;
  Ok(())
}

pub async fn helper_disconnect(app: &AppHandle<RT>, state: &SharedState) -> Result<(), String> {
  let pid_opt = { *OPENVPN_PID.lock().unwrap() };

  if let Some(pid) = pid_opt {
    emit_log(app, &format!("[macos] Disconnect: killing pid={pid} via admin prompt"));
    let _ = run_applescript_admin(&format!("kill -TERM {} >/dev/null 2>&1 || true", pid));
    // give it a moment, then hard kill if needed
    std::thread::sleep(Duration::from_millis(400));
    let _ = run_applescript_admin(&format!("kill -KILL {} >/dev/null 2>&1 || true", pid));
  } else {
    emit_log(app, "[macos] Disconnect requested but no PID tracked");
  }

  *OPENVPN_PID.lock().unwrap() = None;
  *OPENVPN_LOG.lock().unwrap() = None;
  *OPENVPN_PIDFILE.lock().unwrap() = None;
  *OPENVPN_LOG_POS.lock().unwrap() = 0;
  *OPENVPN_START_MS.lock().unwrap() = None;

  set_status(state, app, UiStatus::Disconnected).await;
  Ok(())
}

pub fn spawn_helper_subscriber(app: AppHandle<RT>, state: SharedState) {
  thread::spawn(move || {
    emit_log(&app, "[macos] helper subscriber thread started");

    loop {
      thread::sleep(Duration::from_millis(250));

      let log_path_opt = { OPENVPN_LOG.lock().unwrap().clone() };
      let Some(log_path) = log_path_opt else { continue; };

      // Watchdog: if connecting too long and process is dead, emit readable error
      let start_ms_opt = { *OPENVPN_START_MS.lock().unwrap() };
      if let Some(start_ms) = start_ms_opt {
        let elapsed = super::now_ms().saturating_sub(start_ms);
        if elapsed > super::CONNECT_WATCHDOG_MS + 2_000 {
          let pid_opt = { *OPENVPN_PID.lock().unwrap() };
          if let Some(pid) = pid_opt {
            if !pid_alive(pid) {
              let tail = tail_last_bytes(&log_path, 16_000);
              let app2 = app.clone();
              let st2 = state.clone();
              tauri::async_runtime::spawn(async move {
                set_error_and_disconnect(
                  &st2,
                  &app2,
                  format!("OpenVPN døde under connect på macOS. Log:\n{tail}")
                ).await;
              });

              *OPENVPN_PID.lock().unwrap() = None;
              *OPENVPN_START_MS.lock().unwrap() = None;
            }
          }
        }
      }

      let mut pos = *OPENVPN_LOG_POS.lock().unwrap();

      let mut f = match fs::File::open(&log_path) {
        Ok(f) => f,
        Err(_) => continue,
      };

      if f.seek(SeekFrom::Start(pos)).is_err() {
        continue;
      }

      let mut buf = Vec::new();
      if f.read_to_end(&mut buf).is_err() {
        continue;
      }

      if buf.is_empty() {
        continue;
      }

      pos += buf.len() as u64;
      *OPENVPN_LOG_POS.lock().unwrap() = pos;

      let chunk = String::from_utf8_lossy(&buf);
      for line in chunk.lines() {
        let line = line.trim_end();
        if line.is_empty() {
          continue;
        }

        emit_log(&app, line);

        if line.contains("Initialization Sequence Completed") {
          let app2 = app.clone();
          let st2 = state.clone();
          tauri::async_runtime::spawn(async move {
            emit_log(&app2, "[macos] OpenVPN init completed");
            set_status(&st2, &app2, UiStatus::Connected).await;
          });
          *OPENVPN_START_MS.lock().unwrap() = None;
        }

        if line.contains("AUTH_FAILED") || line.contains("auth-failure") {
          let app2 = app.clone();
          let st2 = state.clone();
          tauri::async_runtime::spawn(async move {
            set_error_and_disconnect(&st2, &app2, "OpenVPN authentication failed (AUTH_FAILED).".to_string()).await;
          });
          *OPENVPN_START_MS.lock().unwrap() = None;
        }
      }
    }
  });
}
