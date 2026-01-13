// src-tauri/bin/stellar-vpn-helper-macos.rs
//
// Root LaunchDaemon that runs OpenVPN and exposes a small JSON IPC over a Unix socket.
// Socket permissions are root:admin 0660 (admin users can connect).
//
// Commands (JSON line):
//   {"cmd":"status"}
//   {"cmd":"connect","openvpn_path":"...","config_path":"...","auth_path":"..."}
//   {"cmd":"disconnect"}
//   {"cmd":"subscribe"}  -> keeps connection open, streams {"type":"log"/"status","..."} lines
//
#![cfg(target_os = "macos")]

use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
  fs,
  path::Path,
  process::Stdio,
  sync::Arc,
};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  net::{UnixListener, UnixStream},
  process::{Child, Command},
  sync::{broadcast, Mutex},
  time::{sleep, Duration},
};

const SOCKET_PATH: &str = "/var/run/org.stellarsecurity.vpn.helper.sock";

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
enum Event {
  #[serde(rename = "log")]
  Log { line: String },
  #[serde(rename = "status")]
  Status { value: String },
}

#[derive(Debug, Default)]
struct HelperState {
  status: String,         // "disconnected" | "connecting" | "connected"
  child: Option<Child>,
}

#[derive(Debug, Deserialize)]
struct Request {
  cmd: String,
  openvpn_path: Option<String>,
  config_path: Option<String>,
  auth_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct Response {
  ok: bool,
  status: Option<String>,
  error: Option<String>,
}

fn log_line(tx: &broadcast::Sender<Event>, s: impl Into<String>) {
  let _ = tx.send(Event::Log { line: s.into() });
}

fn status_set(state: &mut HelperState, tx: &broadcast::Sender<Event>, v: &str) {
  state.status = v.to_string();
  let _ = tx.send(Event::Status { value: v.to_string() });
}

fn remove_socket_best_effort() {
  let _ = fs::remove_file(SOCKET_PATH);
}

fn gid_for_group(name: &str) -> Option<u32> {
  unsafe {
    let c = std::ffi::CString::new(name).ok()?;
    let grp = libc::getgrnam(c.as_ptr());
    if grp.is_null() {
      return None;
    }
    Some((*grp).gr_gid as u32)
  }
}

fn chmod_chown_socket_admin() -> Result<()> {
  // root:admin 0660
  let gid = gid_for_group("admin").ok_or_else(|| anyhow!("group 'admin' not found"))?;

  let cpath = std::ffi::CString::new(SOCKET_PATH).context("CString socket path")?;
  let rc1 = unsafe { libc::chown(cpath.as_ptr(), 0, gid) }; // uid=0 root
  if rc1 != 0 {
    return Err(anyhow!("chown root:admin failed (errno={})", unsafe { *libc::__error() }));
  }

  let rc2 = unsafe { libc::chmod(cpath.as_ptr(), 0o660) };
  if rc2 != 0 {
    return Err(anyhow!("chmod 0660 failed (errno={})", unsafe { *libc::__error() }));
  }

  Ok(())
}

async fn handle_connect(
  req: Request,
  state: Arc<Mutex<HelperState>>,
  tx: broadcast::Sender<Event>,
) -> Result<Response> {
  let openvpn = req.openvpn_path.ok_or_else(|| anyhow!("openvpn_path is required"))?;
  let cfg = req.config_path.ok_or_else(|| anyhow!("config_path is required"))?;
  let auth = req.auth_path.ok_or_else(|| anyhow!("auth_path is required"))?;

  if !Path::new(&openvpn).exists() {
    return Ok(Response { ok: false, status: None, error: Some(format!("openvpn_path not found: {openvpn}")) });
  }
  if !Path::new(&cfg).exists() {
    return Ok(Response { ok: false, status: None, error: Some(format!("config_path not found: {cfg}")) });
  }
  if !Path::new(&auth).exists() {
    return Ok(Response { ok: false, status: None, error: Some(format!("auth_path not found: {auth}")) });
  }

  // Stop any existing session
  {
    let mut g = state.lock().await;
    if let Some(mut child) = g.child.take() {
      status_set(&mut g, &tx, "disconnected");
      log_line(&tx, "[helper] Stopping existing OpenVPN session...");
      let _ = child.kill().await;
      let _ = child.wait().await;
    }
  }

  {
    let mut g = state.lock().await;
    status_set(&mut g, &tx, "connecting");
  }

  log_line(&tx, format!("[helper] Starting OpenVPN"));
  log_line(&tx, format!("[helper] openvpn: {openvpn}"));
  log_line(&tx, format!("[helper] config: {cfg}"));

  let mut cmd = Command::new(&openvpn);
  cmd.kill_on_drop(true)
    .arg("--config").arg(&cfg)
    .arg("--auth-user-pass").arg(&auth)
    .arg("--auth-nocache")
    .arg("--redirect-gateway").arg("def1")
    .arg("--verb").arg("3")
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = cmd.spawn().context("spawn openvpn")?;

  let stdout = child.stdout.take();
  let stderr = child.stderr.take();

  let (line_tx, mut line_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

  if let Some(out) = stdout {
    let tx2 = line_tx.clone();
    tokio::spawn(async move {
      let mut r = BufReader::new(out).lines();
      while let Ok(Some(line)) = r.next_line().await {
        let _ = tx2.send(line);
      }
    });
  }

  if let Some(err) = stderr {
    let tx2 = line_tx.clone();
    tokio::spawn(async move {
      let mut r = BufReader::new(err).lines();
      while let Ok(Some(line)) = r.next_line().await {
        let _ = tx2.send(line);
      }
    });
  }

  // Store child in state
  {
    let mut g = state.lock().await;
    g.child = Some(child);
  }

  // Monitor logs + status
  let state2 = state.clone();
  let tx2 = tx.clone();
  tokio::spawn(async move {
    let mut init_done = false;

    loop {
      tokio::select! {
        Some(line) = line_rx.recv() => {
          log_line(&tx2, line.clone());

          if !init_done && line.contains("Initialization Sequence Completed") {
            init_done = true;
            let mut g = state2.lock().await;
            status_set(&mut g, &tx2, "connected");

            // Best-effort: delete auth file once connected
            let _ = fs::remove_file(&auth);
            log_line(&tx2, "[helper] Connected. Auth file removed (best-effort).");
          }

          if line.contains("AUTH_FAILED") || line.contains("auth-failure") {
            let mut g = state2.lock().await;
            status_set(&mut g, &tx2, "disconnected");
            log_line(&tx2, "[helper] AUTH_FAILED");
            break;
          }
        }
        else => {
          break;
        }
      }
    }
  });

  // Also monitor process exit
  let state3 = state.clone();
  let tx3 = tx.clone();
  tokio::spawn(async move {
    // Wait until child is gone (poll)
    loop {
      let exited = {
        let mut g = state3.lock().await;
        if let Some(child) = g.child.as_mut() {
          match child.try_wait() {
            Ok(Some(status)) => {
              log_line(&tx3, format!("[helper] OpenVPN exited: {:?}", status.code()));
              status_set(&mut g, &tx3, "disconnected");
              g.child = None;
              true
            }
            Ok(None) => false,
            Err(e) => {
              log_line(&tx3, format!("[helper] try_wait failed: {e}"));
              status_set(&mut g, &tx3, "disconnected");
              g.child = None;
              true
            }
          }
        } else {
          true
        }
      };

      if exited { break; }
      sleep(Duration::from_millis(300)).await;
    }
  });

  let st = { state.lock().await.status.clone() };
  Ok(Response { ok: true, status: Some(st), error: None })
}

async fn handle_disconnect(state: Arc<Mutex<HelperState>>, tx: broadcast::Sender<Event>) -> Result<Response> {
  let mut g = state.lock().await;
  if let Some(mut child) = g.child.take() {
    log_line(&tx, "[helper] Disconnect requested. Killing OpenVPN...");
    let _ = child.kill().await;
    let _ = child.wait().await;
  }
  status_set(&mut g, &tx, "disconnected");

  Ok(Response { ok: true, status: Some(g.status.clone()), error: None })
}

async fn handle_status(state: Arc<Mutex<HelperState>>) -> Result<Response> {
  let st = state.lock().await.status.clone();
  Ok(Response { ok: true, status: Some(st), error: None })
}

async fn serve_subscribe(mut stream: UnixStream, tx: broadcast::Sender<Event>, state: Arc<Mutex<HelperState>>) -> Result<()> {
  // Immediately send current status first
  let st = state.lock().await.status.clone();
  let first = serde_json::to_string(&Event::Status { value: st })?;
  stream.write_all(first.as_bytes()).await?;
  stream.write_all(b"\n").await?;

  let mut rx = tx.subscribe();
  loop {
    match rx.recv().await {
      Ok(ev) => {
        let line = serde_json::to_string(&ev)?;
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\n").await?;
      }
      Err(broadcast::error::RecvError::Lagged(_)) => continue,
      Err(_) => break,
    }
  }
  Ok(())
}

async fn serve_conn(stream: UnixStream, state: Arc<Mutex<HelperState>>, tx: broadcast::Sender<Event>) -> Result<()> {
  let mut reader = BufReader::new(stream);
  let mut line = String::new();
  reader.read_line(&mut line).await?;
  let req: Request = serde_json::from_str(line.trim()).context("parse request")?;

  let stream = reader.into_inner();

  if req.cmd == "subscribe" {
    return serve_subscribe(stream, tx, state).await;
  }

  let resp = match req.cmd.as_str() {
    "connect" => handle_connect(req, state, tx).await?,
    "disconnect" => handle_disconnect(state, tx).await?,
    "status" => handle_status(state).await?,
    _ => Response { ok: false, status: None, error: Some("unknown cmd".to_string()) },
  };

  let out = serde_json::to_string(&resp)?;
  let mut s = stream;
  s.write_all(out.as_bytes()).await?;
  s.write_all(b"\n").await?;
  Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
  // Ensure clean socket
  remove_socket_best_effort();

  let listener = UnixListener::bind(SOCKET_PATH).context("bind unix socket")?;
  chmod_chown_socket_admin().context("set socket permissions")?;

  let (tx, _rx) = broadcast::channel::<Event>(2048);

  let state = Arc::new(Mutex::new(HelperState {
    status: "disconnected".to_string(),
    child: None,
  }));

  log_line(&tx, "[helper] Stellar VPN helper started");

  loop {
    let (stream, _addr) = listener.accept().await.context("accept")?;
    let state2 = state.clone();
    let tx2 = tx.clone();
    tokio::spawn(async move {
      if let Err(e) = serve_conn(stream, state2, tx2).await {
        // If a client disconnects mid-stream, that's fine. Keep noise low.
        let _ = e;
      }
    });
  }
}
