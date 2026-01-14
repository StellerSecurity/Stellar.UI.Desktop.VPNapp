// src-tauri/bin/stellar-vpn-macos-helper.rs
//
// Minimal privileged helper for macOS:
// - listens on a Unix socket
// - starts/stops OpenVPN as root
// - broadcasts logs + status to subscribers
//
// DEV: run it with sudo:
//   sudo ./target/debug/stellar-vpn-macos-helper --socket /tmp/stellar-vpn-helper.sock

use std::{
  path::{Path, PathBuf},
  sync::Arc,
  time::Duration,
};

use clap::Parser;
use serde::{Deserialize, Serialize};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  net::{UnixListener, UnixStream},
  process::Command,
  sync::{broadcast, Mutex},
  time,
};

#[derive(Parser, Debug)]
struct Args {
    #[arg(long, default_value = "/tmp/stellar-vpn-helper.sock")]
    socket: String,
}

#[derive(Debug, Serialize)]
struct Resp {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
enum Req {
    Connect {
        openvpn: String,
        config: String,
        auth: String,
    },
    Disconnect,
    Subscribe,
    Status,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum St {
    Disconnected,
    Connecting,
    Connected,
}
impl St {
    fn as_str(&self) -> &'static str {
        match self {
            St::Disconnected => "disconnected",
            St::Connecting => "connecting",
            St::Connected => "connected",
        }
    }
}

struct Inner {
    status: St,
    child: Option<tokio::process::Child>,
}

fn is_safe_openvpn_path(p: &str) -> bool {
    // cheap hardening: don't let random root commands happen
    let s = p.trim();
    if s.is_empty() {
        return false;
    }
    // must exist and be a file
    if !Path::new(s).is_file() {
        return false;
    }
    // must contain "openvpn" in filename (prevents passing /bin/sh etc)
    Path::new(s)
        .file_name()
        .and_then(|x| x.to_str())
        .map(|n| n.starts_with("openvpn"))
        .unwrap_or(false)
}

fn is_safe_temp_path(p: &str) -> bool {
    let s = p.trim();
    if s.is_empty() {
        return false;
    }
    // require our temp dir prefix to reduce abuse
    s.starts_with("/var/folders/")
        || s.starts_with("/tmp/stellar-vpn-desktop")
        || s.starts_with("/tmp/")
}

async fn write_json_line(mut s: &UnixStream, v: &Resp) -> std::io::Result<()> {
    let line = serde_json::to_string(v).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    s.writable().await?;
    s.try_write(format!("{line}\n").as_bytes())?;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Log { line: String },
    Status { status: String },
}

async fn send_event(tx: &broadcast::Sender<String>, ev: Event) {
    if let Ok(line) = serde_json::to_string(&ev) {
        let _ = tx.send(line);
    }
}

async fn run_openvpn(
    mut cmd: Command,
    ev_tx: broadcast::Sender<String>,
    inner: Arc<Mutex<Inner>>,
) -> Result<tokio::process::Child, String> {
    cmd.kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start openvpn: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // stdout lines
    if let Some(out) = stdout {
        let tx = ev_tx.clone();
        let inner2 = inner.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(out).lines();
            while let Ok(Some(line)) = r.next_line().await {
                send_event(&tx, Event::Log { line: line.clone() }).await;

                if line.contains("Initialization Sequence Completed") {
                    {
                        let mut g = inner2.lock().await;
                        g.status = St::Connected;
                    }
                    send_event(
                        &tx,
                        Event::Status {
                            status: "connected".into(),
                        },
                    )
                    .await;
                }
            }
        });
    }

    // stderr lines
    if let Some(err) = stderr {
        let tx = ev_tx.clone();
        tokio::spawn(async move {
            let mut r = BufReader::new(err).lines();
            while let Ok(Some(line)) = r.next_line().await {
                send_event(&tx, Event::Log { line }).await;
            }
        });
    }

    // child watcher
    {
        let tx = ev_tx.clone();
        let inner2 = inner.clone();
        tokio::spawn(async move {
            let code = match child.wait().await {
                Ok(s) => s.code().unwrap_or(-1),
                Err(_) => -1,
            };

            send_event(
                &tx,
                Event::Log {
                    line: format!("[mac-helper] OpenVPN exited (code={code})"),
                },
            )
            .await;

            {
                let mut g = inner2.lock().await;
                g.child = None;
                g.status = St::Disconnected;
            }
            send_event(
                &tx,
                Event::Status {
                    status: "disconnected".into(),
                },
            )
            .await;
        });
    }

    Ok(child)
}

async fn handle_conn(
    mut stream: UnixStream,
    inner: Arc<Mutex<Inner>>,
    ev_tx: broadcast::Sender<String>,
    ev_rx: broadcast::Receiver<String>,
) {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();

    if reader
        .read_line(&mut line)
        .await
        .ok()
        .filter(|n| *n > 0)
        .is_none()
    {
        return;
    }

    let req: Req = match serde_json::from_str(line.trim()) {
        Ok(r) => r,
        Err(e) => {
            let _ = reader
                .get_mut()
                .write_all(format!("{{\"ok\":false,\"error\":\"bad json: {e}\"}}\n").as_bytes())
                .await;
            return;
        }
    };

    match req {
        Req::Subscribe => {
            // confirm current status
            let st = { inner.lock().await.status };
            let _ = reader
                .get_mut()
                .write_all(
                    format!(
                        "{}\n",
                        serde_json::to_string(&Event::Status {
                            status: st.as_str().into()
                        })
                        .unwrap()
                    )
                    .as_bytes(),
                )
                .await;

            let mut rx = ev_rx;
            loop {
                match rx.recv().await {
                    Ok(msg) => {
                        if reader
                            .get_mut()
                            .write_all(format!("{msg}\n").as_bytes())
                            .await
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(_) => break,
                }
            }
        }

        Req::Status => {
            let st = { inner.lock().await.status };
            let _ = reader
                .get_mut()
                .write_all(
                    serde_json::to_string(&Resp {
                        ok: true,
                        error: None,
                        status: Some(st.as_str().into()),
                    })
                    .unwrap()
                    .as_bytes(),
                )
                .await;
            let _ = reader.get_mut().write_all(b"\n").await;
        }

        Req::Disconnect => {
            {
                let mut g = inner.lock().await;
                if let Some(mut c) = g.child.take() {
                    let _ = c.kill().await;
                    let _ = c.wait().await;
                }
                g.status = St::Disconnected;
            }
            send_event(
                &ev_tx,
                Event::Status {
                    status: "disconnected".into(),
                },
            )
            .await;

            let _ = reader
                .get_mut()
                .write_all(
                    serde_json::to_string(&Resp {
                        ok: true,
                        error: None,
                        status: None,
                    })
                    .unwrap()
                    .as_bytes(),
                )
                .await;
            let _ = reader.get_mut().write_all(b"\n").await;
        }

        Req::Connect {
            openvpn,
            config,
            auth,
        } => {
            // Hardening
            if !is_safe_openvpn_path(&openvpn) {
                let _ = reader
                    .get_mut()
                    .write_all(
                        serde_json::to_string(&Resp {
                            ok: false,
                            error: Some("unsafe openvpn path".into()),
                            status: None,
                        })
                        .unwrap()
                        .as_bytes(),
                    )
                    .await;
                let _ = reader.get_mut().write_all(b"\n").await;
                return;
            }
            if !Path::new(&config).exists()
                || !is_safe_temp_path(&config) && !Path::new(&config).is_file()
            {
                // allow non-temp configs too, but they must be files
                if !Path::new(&config).is_file() {
                    let _ = reader
                        .get_mut()
                        .write_all(
                            serde_json::to_string(&Resp {
                                ok: false,
                                error: Some("config path not found".into()),
                                status: None,
                            })
                            .unwrap()
                            .as_bytes(),
                        )
                        .await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                    return;
                }
            }
            if !Path::new(&auth).is_file() || !is_safe_temp_path(&auth) {
                let _ = reader
                    .get_mut()
                    .write_all(
                        serde_json::to_string(&Resp {
                            ok: false,
                            error: Some("auth path not found/unsafe".into()),
                            status: None,
                        })
                        .unwrap()
                        .as_bytes(),
                    )
                    .await;
                let _ = reader.get_mut().write_all(b"\n").await;
                return;
            }

            // kill existing
            {
                let mut g = inner.lock().await;
                if let Some(mut c) = g.child.take() {
                    let _ = c.kill().await;
                    let _ = c.wait().await;
                }
                g.status = St::Connecting;
            }
            send_event(
                &ev_tx,
                Event::Status {
                    status: "connecting".into(),
                },
            )
            .await;
            send_event(
                &ev_tx,
                Event::Log {
                    line: "[mac-helper] starting OpenVPN…".into(),
                },
            )
            .await;

            let mut cmd = Command::new(PathBuf::from(openvpn));
            cmd.arg("--config")
                .arg(config)
                .arg("--auth-user-pass")
                .arg(auth)
                .arg("--auth-nocache")
                .arg("--redirect-gateway")
                .arg("def1")
                .arg("--verb")
                .arg("3");

            match run_openvpn(cmd, ev_tx.clone(), inner.clone()).await {
                Ok(child) => {
                    {
                        let mut g = inner.lock().await;
                        g.child = Some(child);
                    }

                    // remove auth file (root)
                    // best-effort only
                    // (OpenVPN reads it immediately; keeping it is pointless risk)
                    // ignore errors
                    // NOTE: we do not delete config here; app may reuse cache.
                    let _ = tokio::fs::remove_file(&auth).await;

                    let _ = reader
                        .get_mut()
                        .write_all(
                            serde_json::to_string(&Resp {
                                ok: true,
                                error: None,
                                status: None,
                            })
                            .unwrap()
                            .as_bytes(),
                        )
                        .await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }
                Err(e) => {
                    {
                        let mut g = inner.lock().await;
                        g.child = None;
                        g.status = St::Disconnected;
                    }
                    send_event(
                        &ev_tx,
                        Event::Status {
                            status: "disconnected".into(),
                        },
                    )
                    .await;

                    let _ = reader
                        .get_mut()
                        .write_all(
                            serde_json::to_string(&Resp {
                                ok: false,
                                error: Some(e),
                                status: None,
                            })
                            .unwrap()
                            .as_bytes(),
                        )
                        .await;
                    let _ = reader.get_mut().write_all(b"\n").await;
                }
            }
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // must be root
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("This helper must run as root.");
        std::process::exit(1);
    }

    let args = Args::parse();

    // cleanup stale socket
    let _ = std::fs::remove_file(&args.socket);

    let listener = UnixListener::bind(&args.socket)?;
    // lock it down
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&args.socket, std::fs::Permissions::from_mode(0o600));
    }

    let (ev_tx, _ev_rx) = broadcast::channel::<String>(200);

    let inner = Arc::new(Mutex::new(Inner {
        status: St::Disconnected,
        child: None,
    }));

    loop {
        let (stream, _) = listener.accept().await?;
        let ev_rx = ev_tx.subscribe();
        tokio::spawn(handle_conn(stream, inner.clone(), ev_tx.clone(), ev_rx));
        time::sleep(Duration::from_millis(5)).await;
    }
}
