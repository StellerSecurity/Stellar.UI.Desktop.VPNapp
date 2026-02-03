// src-tauri/bin/stellar-vpn-helper-macos.rs
//
// Privileged macOS helper (runs as root via LaunchDaemon)
// - Listens on a Unix socket (default: /tmp/stellar-vpn-helper.sock)
// - Accepts JSON lines: connect / disconnect / subscribe / status
// - Starts/stops OpenVPN as root
// - Broadcasts logs + status to all subscribers
//
// IMPORTANT FIXES:
// - Socket permissions are set to 0666 so the non-root GUI app can connect (avoids os error 13).
// - Child watcher uses try_wait() (does NOT move the child out), so disconnect can still kill it.

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
    /// Unix socket path the helper listens on
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
        username: String,
        password: String,
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

#[derive(Debug)]
struct Inner {
    status: St,
    child: Option<tokio::process::Child>,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event {
    Log { line: String },
    Status { status: String },
}

fn is_safe_openvpn_path(p: &str) -> bool {
    let s = p.trim();
    if s.is_empty() {
        return false;
    }
    let path = Path::new(s);
    if !path.is_file() {
        return false;
    }
    // basic hardening: require filename starts with "openvpn"
    path.file_name()
        .and_then(|x| x.to_str())
        .map(|n| n.starts_with("openvpn"))
        .unwrap_or(false)
}

fn is_safe_config_path(p: &str) -> bool {
    let s = p.trim();
    if s.is_empty() {
        return false;
    }
    let path = Path::new(s);
    if path.is_file() {
        return true;
    }
    // Allow temp paths commonly used by your app
    s.starts_with("/var/folders/")
        || s.starts_with("/tmp/stellar-vpn-desktop")
        || s.starts_with("/tmp/")
}

async fn write_json(stream: &mut UnixStream, v: &impl Serialize) -> std::io::Result<()> {
    let line = serde_json::to_string(v).unwrap_or_else(|_| "{\"ok\":false}".to_string());
    stream.write_all(line.as_bytes()).await?;
    stream.write_all(b"\n").await?;
    Ok(())
}

async fn send_event(tx: &broadcast::Sender<String>, ev: Event) {
    if let Ok(line) = serde_json::to_string(&ev) {
        let _ = tx.send(line);
    }
}

fn make_auth_path() -> PathBuf {
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    PathBuf::from(format!("/tmp/stellar-vpn-desktop/auth-{t}.txt"))
}

async fn write_auth_file(path: &Path, username: &str, password: &str) -> Result<(), String> {
    if username.trim().is_empty() || password.trim().is_empty() {
        return Err("missing username/password".into());
    }

    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("Failed to create auth dir: {e}"))?;
    }

    tokio::fs::write(path, format!("{username}\n{password}\n"))
        .await
        .map_err(|e| format!("Failed to write auth file: {e}"))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }

    Ok(())
}

async fn spawn_child_watcher(inner: Arc<Mutex<Inner>>, ev_tx: broadcast::Sender<String>) {
    tokio::spawn(async move {
        loop {
            let exited = {
                let mut g = inner.lock().await;
                if let Some(child) = g.child.as_mut() {
                    match child.try_wait() {
                        Ok(Some(status)) => {
                            let code = status.code().unwrap_or(-1);
                            g.child = None;
                            g.status = St::Disconnected;
                            Some(code)
                        }
                        Ok(None) => None,
                        Err(_) => {
                            g.child = None;
                            g.status = St::Disconnected;
                            Some(-1)
                        }
                    }
                } else {
                    // nothing running
                    return;
                }
            };

            if let Some(code) = exited {
                send_event(
                    &ev_tx,
                    Event::Log {
                        line: format!("[mac-helper] OpenVPN exited (code={code})"),
                    },
                )
                .await;
                send_event(
                    &ev_tx,
                    Event::Status {
                        status: "disconnected".into(),
                    },
                )
                .await;
                return;
            }

            time::sleep(Duration::from_millis(200)).await;
        }
    });
}

async fn handle_conn(
    stream: UnixStream,
    inner: Arc<Mutex<Inner>>,
    ev_tx: broadcast::Sender<String>,
    mut ev_rx: broadcast::Receiver<String>,
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
            // send current status immediately
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

            // stream events
            loop {
                match ev_rx.recv().await {
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
            let _ = write_json(
                reader.get_mut(),
                &Resp {
                    ok: true,
                    error: None,
                    status: Some(st.as_str().into()),
                },
            )
            .await;
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

            let _ = write_json(
                reader.get_mut(),
                &Resp {
                    ok: true,
                    error: None,
                    status: None,
                },
            )
            .await;
        }

        Req::Connect {
            openvpn,
            config,
            username,
            password,
        } => {
            if !is_safe_openvpn_path(&openvpn) {
                let _ = write_json(
                    reader.get_mut(),
                    &Resp {
                        ok: false,
                        error: Some("unsafe openvpn path".into()),
                        status: None,
                    },
                )
                .await;
                return;
            }

            if !is_safe_config_path(&config) || !Path::new(&config).exists() {
                let _ = write_json(
                    reader.get_mut(),
                    &Resp {
                        ok: false,
                        error: Some("config path not found/unsafe".into()),
                        status: None,
                    },
                )
                .await;
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

            // auth file
            let auth_path = make_auth_path();
            if let Err(e) = write_auth_file(&auth_path, &username, &password).await {
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

                let _ = write_json(
                    reader.get_mut(),
                    &Resp {
                        ok: false,
                        error: Some(e),
                        status: None,
                    },
                )
                .await;
                return;
            }

            let mut cmd = Command::new(PathBuf::from(openvpn));
            cmd.arg("--config")
                .arg(&config)
                .arg("--auth-user-pass")
                .arg(&auth_path)
                .arg("--auth-nocache")
                .arg("--redirect-gateway")
                .arg("def1")
                .arg("--verb")
                .arg("3")
                .kill_on_drop(true)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());

            let mut child = match cmd.spawn() {
                Ok(c) => c,
                Err(e) => {
                    let _ = tokio::fs::remove_file(&auth_path).await;
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

                    let _ = write_json(
                        reader.get_mut(),
                        &Resp {
                            ok: false,
                            error: Some(format!("Failed to start openvpn: {e}")),
                            status: None,
                        },
                    )
                    .await;
                    return;
                }
            };

            // pipe logs
            if let Some(out) = child.stdout.take() {
                let tx = ev_tx.clone();
                let inner2 = inner.clone();
                tokio::spawn(async move {
                    let mut r = BufReader::new(out).lines();
                    while let Ok(Some(l)) = r.next_line().await {
                        send_event(&tx, Event::Log { line: l.clone() }).await;
                        if l.contains("Initialization Sequence Completed") {
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
                        if l.contains("AUTH_FAILED") || l.contains("auth-failure") {
                            send_event(
                                &tx,
                                Event::Log {
                                    line: "[mac-helper] AUTH_FAILED detected".into(),
                                },
                            )
                            .await;
                        }
                    }
                });
            }

            if let Some(err) = child.stderr.take() {
                let tx = ev_tx.clone();
                tokio::spawn(async move {
                    let mut r = BufReader::new(err).lines();
                    while let Ok(Some(l)) = r.next_line().await {
                        send_event(&tx, Event::Log { line: l }).await;
                    }
                });
            }

            // store child + start watcher (try_wait based)
            {
                let mut g = inner.lock().await;
                g.child = Some(child);
            }
            spawn_child_watcher(inner.clone(), ev_tx.clone()).await;

            // delete auth after a small delay (avoid race)
            let auth_to_delete = auth_path.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(2)).await;
                let _ = tokio::fs::remove_file(&auth_to_delete).await;
            });

            let _ = write_json(
                reader.get_mut(),
                &Resp {
                    ok: true,
                    error: None,
                    status: None,
                },
            )
            .await;
        }
    }
}

fn set_socket_perms(socket_path: &str) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // 0666 so non-root GUI can connect
        let _ = std::fs::set_permissions(socket_path, std::fs::Permissions::from_mode(0o666));
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if unsafe { libc::geteuid() } != 0 {
        eprintln!("This helper must run as root.");
        std::process::exit(1);
    }

    let args = Args::parse();

    // remove old socket
    let _ = std::fs::remove_file(&args.socket);

    // bind
    let listener = UnixListener::bind(&args.socket)?;

    // IMPORTANT: make socket connectable by the GUI app
    set_socket_perms(&args.socket);

    let (ev_tx, _ev_rx) = broadcast::channel::<String>(512);

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
