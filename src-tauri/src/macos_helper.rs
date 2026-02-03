// src-tauri/src/macos_helper.rs
//
// macOS client-side helper bridge (runs inside Tauri app):
// - connects to privileged helper via Unix socket
// - sends Connect/Disconnect/Subscribe commands
// - forwards helper log/status events to UI
//
// IMPORTANT: Use tauri::async_runtime::spawn (NOT tokio::spawn) from sync contexts.

use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

const HELPER_SOCK: &str = "/tmp/stellar-vpn-helper.sock";

#[derive(Debug, Serialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum HelperReq {
  Connect {
    openvpn: String,
    config: String,
    username: String,
    password: String,
  },
  Disconnect,
  Subscribe,
  Status,
}

#[derive(Debug, Deserialize)]
struct HelperResp {
  ok: bool,
  #[serde(default)]
  error: Option<String>,
  #[serde(default)]
  status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum HelperEvent {
  Log { line: String },
  Status { status: String },
}

fn emit_log<RT: Runtime>(app: &AppHandle<RT>, line: &str) {
  let _ = app.emit("vpn-log", line.to_string());
}

fn emit_status<RT: Runtime>(app: &AppHandle<RT>, status: &str) {
  let _ = app.emit("vpn-status", status.to_string());
}

async fn write_json_line(stream: &mut tokio::net::UnixStream, v: &impl Serialize) -> Result<(), String> {
  use tokio::io::AsyncWriteExt;

  let s = serde_json::to_string(v).map_err(|e| format!("json encode failed: {e}"))?;
  stream
    .write_all(format!("{s}\n").as_bytes())
    .await
    .map_err(|e| format!("socket write failed: {e}"))?;
  Ok(())
}

async fn read_json_line<T: for<'de> Deserialize<'de>>(stream: &mut tokio::net::UnixStream) -> Result<T, String> {
  use tokio::io::{AsyncBufReadExt, BufReader};

  let mut reader = BufReader::new(stream);
  let mut line = String::new();
  let n = reader
    .read_line(&mut line)
    .await
    .map_err(|e| format!("socket read failed: {e}"))?;
  if n == 0 {
    return Err("socket closed".to_string());
  }
  serde_json::from_str::<T>(line.trim()).map_err(|e| format!("json decode failed: {e}"))
}

async fn connect_socket() -> Result<tokio::net::UnixStream, String> {
  tokio::net::UnixStream::connect(HELPER_SOCK)
    .await
    .map_err(|e| format!("Failed to connect to helper socket {HELPER_SOCK}: {e}"))
}

pub async fn helper_connect<RT: Runtime>(
  app: &AppHandle<RT>,
  _state: &std::sync::Arc<tokio::sync::Mutex<crate::VpnInner>>,
  openvpn_bin: PathBuf,
  cfg_path: PathBuf,
  username: String,
  password: String,
) -> Result<(), String> {
  emit_log(app, "[macos] helper_connect -> using root helper socket");

  let mut s = connect_socket().await?;

  // Send Connect request
  write_json_line(
    &mut s,
    &HelperReq::Connect {
      openvpn: openvpn_bin.to_string_lossy().to_string(),
      config: cfg_path.to_string_lossy().to_string(),
      username,
      password,
    },
  )
  .await?;

  // Read response
  let resp: HelperResp = read_json_line(&mut s).await?;
  if !resp.ok {
    return Err(format!(
      "Helper connect failed: {}",
      resp.error.unwrap_or_else(|| "unknown error".to_string())
    ));
  }

  Ok(())
}

pub async fn helper_disconnect<RT: Runtime>(
  app: &AppHandle<RT>,
  _state: &std::sync::Arc<tokio::sync::Mutex<crate::VpnInner>>,
) -> Result<(), String> {
  let mut s = connect_socket().await?;
  write_json_line(&mut s, &HelperReq::Disconnect).await?;
  let resp: HelperResp = read_json_line(&mut s).await?;
  if !resp.ok {
    return Err(format!(
      "Helper disconnect failed: {}",
      resp.error.unwrap_or_else(|| "unknown error".to_string())
    ));
  }
  emit_status(app, "disconnected");
  Ok(())
}

/// Spawns a background subscriber that:
/// - connects to helper
/// - sends Subscribe
/// - forwards Event::Log and Event::Status into UI
///
/// IMPORTANT: this function is called from sync Tauri setup; must use tauri::async_runtime::spawn
pub fn spawn_helper_subscriber<RT: Runtime>(
  app: AppHandle<RT>,
  _state: std::sync::Arc<tokio::sync::Mutex<crate::VpnInner>>,
) {
  tauri::async_runtime::spawn(async move {
    loop {
      // try connect
      let mut s = match connect_socket().await {
        Ok(s) => s,
        Err(e) => {
          emit_log(&app, &format!("[macos] helper subscribe connect failed: {e}"));
          tokio::time::sleep(Duration::from_millis(800)).await;
          continue;
        }
      };

      // send subscribe
      if let Err(e) = write_json_line(&mut s, &HelperReq::Subscribe).await {
        emit_log(&app, &format!("[macos] subscribe write failed: {e}"));
        tokio::time::sleep(Duration::from_millis(800)).await;
        continue;
      }

      // Now read streaming event lines until it breaks
      let mut reader = tokio::io::BufReader::new(s);
      loop {
        let mut line = String::new();
        let n = match tokio::io::AsyncBufReadExt::read_line(&mut reader, &mut line).await {
          Ok(n) => n,
          Err(e) => {
            emit_log(&app, &format!("[macos] subscribe read failed: {e}"));
            break;
          }
        };
        if n == 0 {
          emit_log(&app, "[macos] subscribe socket closed");
          break;
        }

        let msg = line.trim();
        if msg.is_empty() {
          continue;
        }

        match serde_json::from_str::<HelperEvent>(msg) {
          Ok(HelperEvent::Log { line }) => {
            emit_log(&app, &line);
          }
          Ok(HelperEvent::Status { status }) => {
            emit_status(&app, &status);
          }
          Err(_) => {
            // If helper prints plain text, forward it as log.
            emit_log(&app, msg);
          }
        }
      }

      // reconnect loop backoff
      tokio::time::sleep(Duration::from_millis(800)).await;
    }
  });
}
