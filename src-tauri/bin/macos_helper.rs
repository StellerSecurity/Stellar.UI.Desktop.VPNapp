// src-tauri/src/macos_helper.rs
//
// Client for the macOS privileged helper (Unix socket JSON protocol).
// This module is used by main.rs on macOS to avoid running OpenVPN unprivileged.
//
// Comments in English only.

#![cfg(target_os = "macos")]

use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  net::UnixStream,
  time::sleep,
};
use tauri::{AppHandle, Emitter};

use crate::{emit_log, emit_status, update_tray_ui, UiStatus, RT, SharedState};

const SOCKET_PATH: &str = "/var/run/org.stellarsecurity.vpn.helper.sock";

async fn helper_request(req: serde_json::Value) -> Result<serde_json::Value, String> {
  let mut s = UnixStream::connect(SOCKET_PATH)
    .await
    .map_err(|e| format!("Helper not running or socket not accessible: {e}"))?;

  let line = req.to_string() + "\n";
  s.write_all(line.as_bytes())
    .await
    .map_err(|e| format!("Helper write failed: {e}"))?;

  let mut r = BufReader::new(s);
  let mut resp_line = String::new();
  r.read_line(&mut resp_line)
    .await
    .map_err(|e| format!("Helper read failed: {e}"))?;

  let v: serde_json::Value = serde_json::from_str(resp_line.trim())
    .map_err(|e| format!("Helper response parse failed: {e}"))?;

  Ok(v)
}

pub async fn helper_connect(
  app: &AppHandle<RT>,
  state: &SharedState,
  openvpn_path: PathBuf,
  cfg_path: PathBuf,
  auth_path: PathBuf,
) -> Result<(), String> {
  let req = json!({
    "cmd": "connect",
    "openvpn_path": openvpn_path.to_string_lossy(),
    "config_path": cfg_path.to_string_lossy(),
    "auth_path": auth_path.to_string_lossy()
  });

  let v = helper_request(req).await?;
  let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
  if !ok {
    let msg = v.get("error").and_then(|x| x.as_str()).unwrap_or("Helper connect failed");
    return Err(msg.to_string());
  }

  // Set status optimistically to connecting; helper will confirm connected via subscribe stream.
  {
    let mut g = state.lock().await;
    g.status = UiStatus::Connecting;
  }
  emit_status(app, UiStatus::Connecting.as_str());
  update_tray_ui(app, UiStatus::Connecting);

  Ok(())
}

pub async fn helper_disconnect(app: &AppHandle<RT>, state: &SharedState) -> Result<(), String> {
  let v = helper_request(json!({ "cmd": "disconnect" })).await?;
  let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
  if !ok {
    let msg = v.get("error").and_then(|x| x.as_str()).unwrap_or("Helper disconnect failed");
    return Err(msg.to_string());
  }

  {
    let mut g = state.lock().await;
    g.status = UiStatus::Disconnected;
  }
  emit_status(app, UiStatus::Disconnected.as_str());
  update_tray_ui(app, UiStatus::Disconnected);

  Ok(())
}

pub fn spawn_helper_subscriber(app: AppHandle<RT>, state: SharedState) {
  tokio::spawn(async move {
    loop {
      // Try connect and subscribe. If helper isn't installed/running yet, retry.
      let stream = UnixStream::connect(SOCKET_PATH).await;
      let mut s = match stream {
        Ok(x) => x,
        Err(_) => {
          sleep(Duration::from_millis(800)).await;
          continue;
        }
      };

      let _ = s.write_all(b"{\"cmd\":\"subscribe\"}\n").await;
      let mut r = BufReader::new(s);
      let mut line = String::new();

      loop {
        line.clear();
        match r.read_line(&mut line).await {
          Ok(0) => break, // disconnected
          Ok(_) => {
            let trimmed = line.trim();
            if trimmed.is_empty() { continue; }

            let v: serde_json::Value = match serde_json::from_str(trimmed) {
              Ok(x) => x,
              Err(_) => continue,
            };

            let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if ty == "log" {
              if let Some(l) = v.get("line").and_then(|x| x.as_str()) {
                emit_log(&app, l);
              }
            } else if ty == "status" {
              if let Some(st) = v.get("value").and_then(|x| x.as_str()) {
                match st {
                  "connected" => {
                    {
                      let mut g = state.lock().await;
                      g.status = UiStatus::Connected;
                    }
                    emit_status(&app, UiStatus::Connected.as_str());
                    update_tray_ui(&app, UiStatus::Connected);
                  }
                  "connecting" => {
                    {
                      let mut g = state.lock().await;
                      g.status = UiStatus::Connecting;
                    }
                    emit_status(&app, UiStatus::Connecting.as_str());
                    update_tray_ui(&app, UiStatus::Connecting);
                  }
                  _ => {
                    {
                      let mut g = state.lock().await;
                      g.status = UiStatus::Disconnected;
                    }
                    emit_status(&app, UiStatus::Disconnected.as_str());
                    update_tray_ui(&app, UiStatus::Disconnected);
                  }
                }
              }
            }
          }
          Err(_) => break,
        }
      }

      // Backoff then reconnect
      sleep(Duration::from_millis(600)).await;
    }
  });
}
