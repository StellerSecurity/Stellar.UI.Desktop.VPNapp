#![cfg_attr(not(target_os = "windows"), allow(dead_code))]

#[cfg(not(target_os = "windows"))]
fn main() {}

#[cfg(target_os = "windows")]
mod windows_helper {
    use serde::{Deserialize, Serialize};
    use std::{
        ffi::OsString,
        io::{BufRead, BufReader, Write},
        net::{TcpListener, TcpStream},
        process::{Child, Command, Stdio},
        sync::{Arc, Mutex},
        thread,
        time::Duration,
    };
    use windows_service::{
        define_windows_service,
        service::{ServiceControl, ServiceControlAccept, ServiceExitCode, ServiceState, ServiceStatus, ServiceType},
        service_control_handler::{self, ServiceControlHandlerResult},
        service_dispatcher,
    };

    const SERVICE_NAME: &str = "StellarVpnHelper";
    const HELPER_ADDR: &str = "127.0.0.1:49877";

    #[derive(Default)]
    struct HelperState {
        child: Option<Child>,
        pid: Option<u32>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(tag = "cmd", rename_all = "snake_case")]
    enum HelperRequest {
        Connect {
            openvpn: String,
            config: String,
            auth: String,
            log: String,
        },
        Disconnect,
        Status,
    }

    #[derive(Debug, Serialize)]
    struct HelperResponse {
        ok: bool,
        message: String,
        pid: Option<u32>,
    }

    define_windows_service!(ffi_service_main, service_main);

    pub fn run() {
        if let Err(e) = service_dispatcher::start(SERVICE_NAME, ffi_service_main) {
            eprintln!("[stellar-vpn-helper-windows] service dispatcher failed: {e}");
        }
    }

    fn service_main(_arguments: Vec<OsString>) {
        if let Err(e) = run_service() {
            eprintln!("[stellar-vpn-helper-windows] service failed: {e}");
        }
    }

    fn run_service() -> windows_service::Result<()> {
        let state = Arc::new(Mutex::new(HelperState::default()));
        let stop_flag = Arc::new(std::sync::atomic::AtomicBool::new(false));

        let stop_flag_for_handler = stop_flag.clone();
        let state_for_handler = state.clone();

        let status_handle = service_control_handler::register(SERVICE_NAME, move |control_event| {
            match control_event {
                ServiceControl::Stop | ServiceControl::Shutdown => {
                    stop_flag_for_handler.store(true, std::sync::atomic::Ordering::SeqCst);
                    kill_current_openvpn(&state_for_handler);
                    ServiceControlHandlerResult::NoError
                }
                ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
                _ => ServiceControlHandlerResult::NotImplemented,
            }
        })?;

        status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Running,
            controls_accepted: ServiceControlAccept::STOP | ServiceControlAccept::SHUTDOWN,
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(0),
            process_id: None,
        })?;

        let listener = match TcpListener::bind(HELPER_ADDR) {
            Ok(listener) => listener,
            Err(e) => {
                eprintln!("[stellar-vpn-helper-windows] failed to bind {HELPER_ADDR}: {e}");
                return Ok(());
            }
        };

        if let Err(e) = listener.set_nonblocking(true) {
            eprintln!("[stellar-vpn-helper-windows] failed to set listener nonblocking: {e}");
            return Ok(());
        }

        while !stop_flag.load(std::sync::atomic::Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _addr)) => {
                    let state_for_client = state.clone();
                    thread::spawn(move || handle_client(stream, state_for_client));
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(150));
                }
                Err(_e) => {
                    thread::sleep(Duration::from_millis(500));
                }
            }
        }

        kill_current_openvpn(&state);

        status_handle.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: ServiceState::Stopped,
            controls_accepted: ServiceControlAccept::empty(),
            exit_code: ServiceExitCode::Win32(0),
            checkpoint: 0,
            wait_hint: Duration::from_secs(0),
            process_id: None,
        })?;

        Ok(())
    }

    fn handle_client(mut stream: TcpStream, state: Arc<Mutex<HelperState>>) {
        let cloned = match stream.try_clone() {
            Ok(s) => s,
            Err(e) => {
                let _ = write_response(&mut stream, false, format!("Failed to clone stream: {e}"), None);
                return;
            }
        };

        let mut reader = BufReader::new(cloned);
        let mut line = String::new();
        if let Err(e) = reader.read_line(&mut line) {
            let _ = write_response(&mut stream, false, format!("Failed to read request: {e}"), None);
            return;
        }

        let request: HelperRequest = match serde_json::from_str(line.trim()) {
            Ok(req) => req,
            Err(e) => {
                let _ = write_response(&mut stream, false, format!("Invalid request JSON: {e}"), None);
                return;
            }
        };

        match request {
            HelperRequest::Connect { openvpn, config, auth, log } => {
                kill_current_openvpn(&state);

                let child = Command::new(&openvpn)
                    .arg("--config")
                    .arg(&config)
                    .arg("--auth-user-pass")
                    .arg(&auth)
                    .arg("--auth-nocache")
                    .arg("--redirect-gateway")
                    .arg("def1")
                    .arg("--verb")
                    .arg("3")
                    .arg("--log")
                    .arg(&log)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn();

                match child {
                    Ok(child) => {
                        let pid = child.id();
                        {
                            let mut guard = state.lock().expect("helper state poisoned");
                            guard.pid = Some(pid);
                            guard.child = Some(child);
                        }
                        let _ = write_response(&mut stream, true, "OpenVPN started".to_string(), Some(pid));
                    }
                    Err(e) => {
                        let _ = write_response(&mut stream, false, format!("Failed to start OpenVPN: {e}"), None);
                    }
                }
            }
            HelperRequest::Disconnect => {
                kill_current_openvpn(&state);
                let _ = write_response(&mut stream, true, "OpenVPN stopped".to_string(), None);
            }
            HelperRequest::Status => {
                let mut guard = state.lock().expect("helper state poisoned");
                let running = match guard.child.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(_)) => {
                            guard.child = None;
                            guard.pid = None;
                            false
                        }
                        Ok(None) => true,
                        Err(_) => false,
                    },
                    None => false,
                };
                let pid = if running { guard.pid } else { None };
                let _ = write_response(&mut stream, true, if running { "running" } else { "stopped" }.to_string(), pid);
            }
        }
    }

    fn write_response(stream: &mut TcpStream, ok: bool, message: String, pid: Option<u32>) -> std::io::Result<()> {
        let response = HelperResponse { ok, message, pid };
        let mut body = serde_json::to_string(&response)?;
        body.push('\n');
        stream.write_all(body.as_bytes())
    }

    fn kill_current_openvpn(state: &Arc<Mutex<HelperState>>) {
        let pid = {
            let mut guard = state.lock().expect("helper state poisoned");
            let pid = guard.pid;
            if let Some(child) = guard.child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            guard.child = None;
            guard.pid = None;
            pid
        };

        if let Some(pid) = pid {
            let _ = Command::new("taskkill")
                .arg("/PID")
                .arg(pid.to_string())
                .arg("/T")
                .arg("/F")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
    }
}

#[cfg(target_os = "windows")]
fn main() {
    windows_helper::run();
}
