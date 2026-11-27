//! Narrow Linux root helper. Requests cannot select executables, paths or shell text.
use std::{fs::{self, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, net::IpAddr,
    os::{fd::AsRawFd, unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, net::{UnixListener, UnixStream}}},
    path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use stellar_core::openvpn::{management_event, ManagementEvent, ValidatedConfig, VpnCredentials};

const ROOT: &str = "/run/stellar-vpn";
const SOCKET: &str = "/run/stellar-vpn/helper.sock";
const OPENVPN: &str = "/usr/sbin/openvpn";
const TUNNEL: &str = "stellar0";
const RESOLVECTL: &str = "/usr/bin/resolvectl";
static CONNECT_LOCK: Mutex<()> = Mutex::new(());
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[repr(C)] struct UCred { pid: i32, uid: u32, gid: u32 }
unsafe extern "C" {
    fn geteuid() -> u32;
    fn getsockopt(fd: i32, level: i32, name: i32, value: *mut core::ffi::c_void, length: *mut u32) -> i32;
    fn chown(path: *const i8, uid: u32, gid: u32) -> i32;
    fn signal(sig: i32, handler: usize) -> usize;
}
extern "C" fn shutdown_signal(_: i32) { SHUTDOWN.store(true, std::sync::atomic::Ordering::Relaxed); }

#[derive(Default)]
struct Tunnel {
    child: Option<Child>, management: Option<UnixStream>, generation: u64, connected: bool,
    server: String, connected_at: u64, received: u64, sent: u64, directory: Option<PathBuf>,
    protected: bool, endpoints: Vec<crate::firewall::Endpoint>, interface: Option<String>,
}
type Shared = Arc<Mutex<Tunnel>>;
fn locked(state: &Shared) -> io::Result<std::sync::MutexGuard<'_, Tunnel>> { state.lock().map_err(|_| io::Error::other("State unavailable")) }

fn command(path: &str, args: &[&str]) -> io::Result<String> {
    let output = Command::new(path).env_clear().env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .args(args).stdin(Stdio::null()).output()?;
    if !output.status.success() || output.stdout.len() > 65_536 || output.stderr.len() > 65_536 { return Err(io::Error::other("System command failed")); }
    String::from_utf8(output.stdout).map_err(|_| io::Error::other("Invalid system command output"))
}
fn clear_dns() { let _ = command(RESOLVECTL, &["revert", TUNNEL]); }
fn apply_dns(servers: &[IpAddr]) -> io::Result<()> {
    if servers.is_empty() || servers.len() > 4 || !Path::new(RESOLVECTL).is_file() { return Err(io::Error::other("VPN DNS unavailable")); }
    let values = servers.iter().map(ToString::to_string).collect::<Vec<_>>();
    let mut dns = vec!["dns", TUNNEL]; dns.extend(values.iter().map(String::as_str));
    command(RESOLVECTL, &dns)?;
    command(RESOLVECTL, &["domain", TUNNEL, "~."])?;
    command(RESOLVECTL, &["default-route", TUNNEL, "yes"])?;
    let current = command(RESOLVECTL, &["dns", TUNNEL])?;
    if !values.iter().all(|value| current.split_whitespace().any(|field| field == value)) { clear_dns(); return Err(io::Error::other("VPN DNS verification failed")); }
    Ok(())
}
fn pushed_dns(line: &str, values: &mut Vec<IpAddr>) {
    if !line.starts_with(">LOG:") || !line.contains("PUSH_REPLY,") { return; }
    for part in line.split(',') {
        let Some(value) = part.trim().strip_prefix("dhcp-option DNS ") else { continue; };
        if let Ok(ip) = value.trim_end_matches('\'').parse::<IpAddr>() {
            if !ip.is_unspecified() && !ip.is_multicast() && !values.contains(&ip) && values.len() < 4 { values.push(ip); }
        }
    }
}
fn verify_tunnel(line: &str) -> io::Result<()> {
    let address = line.strip_prefix(">STATE:").and_then(|value| value.split(',').nth(3))
        .and_then(|value| value.parse::<std::net::Ipv4Addr>().ok()).filter(|value| !value.is_unspecified())
        .ok_or_else(|| io::Error::other("VPN address unavailable"))?;
    let tun = fs::read_to_string(format!("/sys/class/net/{TUNNEL}/tun_flags"))?;
    if tun.trim().is_empty() { return Err(io::Error::other("VPN interface unavailable")); }
    let output = command("/usr/sbin/ip", &["-o", "-4", "address", "show", "dev", TUNNEL])?;
    let address = address.to_string();
    if !output.split_whitespace().any(|field| field.split('/').next() == Some(address.as_str())) { return Err(io::Error::other("VPN interface verification failed")); }
    Ok(())
}
fn stop_inner(tunnel: &mut Tunnel) -> io::Result<()> {
    if tunnel.protected { crate::linux_firewall::arm(&tunnel.endpoints, None)?; }
    tunnel.generation = tunnel.generation.wrapping_add(1); tunnel.connected = false; tunnel.interface = None;
    if let Some(mut management) = tunnel.management.take() { let _ = management.write_all(b"signal SIGTERM\n"); }
    if let Some(mut child) = tunnel.child.take() {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline { if child.try_wait()?.is_some() { break; } thread::sleep(Duration::from_millis(50)); }
        if child.try_wait()?.is_none() { child.kill()?; } let _ = child.wait();
    }
    if let Some(directory) = tunnel.directory.take() {
        let _ = fs::remove_file(directory.join("client.ovpn")); let _ = fs::remove_file(directory.join("management.sock")); let _ = fs::remove_dir(directory);
    }
    clear_dns(); Ok(())
}
fn stop(state: &Shared) -> io::Result<()> {
    let mut tunnel = locked(state)?;
    stop_inner(&mut tunnel)
}
fn stop_generation(state: &Shared, generation: u64) { if let Ok(mut tunnel) = locked(state) { if tunnel.generation == generation { let _ = stop_inner(&mut tunnel); } } }
fn status(state: &Shared, stream: &mut UnixStream) -> io::Result<()> {
    let tunnel = locked(state)?;
    if tunnel.connected { writeln!(stream, "CONNECTED {} {} {} {}", tunnel.server, tunnel.connected_at, tunnel.received, tunnel.sent) }
    else if tunnel.protected { stream.write_all(b"BLOCKED\n") } else { stream.write_all(b"DISCONNECTED\n") }
}
fn read_line(reader: &mut impl BufRead, maximum: usize) -> io::Result<String> {
    let mut bytes = Vec::new();
    loop { let mut byte = [0u8]; match reader.read_exact(&mut byte) {
        Ok(()) if byte[0] == b'\n' => break,
        Ok(()) => { bytes.push(byte[0]); if bytes.len() > maximum { return Err(io::Error::other("Message too large")); } },
        Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) && bytes.is_empty() => return Ok(String::new()),
        Err(error) => return Err(error),
    }}
    String::from_utf8(bytes).map(|value| value.trim_end_matches('\r').to_owned()).map_err(|_| io::Error::other("Invalid message"))
}
fn endpoints(config: &ValidatedConfig) -> io::Result<Vec<crate::firewall::Endpoint>> {
    let tcp = config.as_str().lines().any(|line| matches!(line, "proto tcp-client" | "proto tcp4-client"));
    let mut result = Vec::new();
    for line in config.as_str().lines() { let fields = line.split_whitespace().collect::<Vec<_>>(); if let ["remote", address, port] = fields.as_slice() {
        result.push(crate::firewall::Endpoint { ip: address.parse().map_err(|_| io::Error::other("Kill switch requires literal VPN endpoints"))?, port: port.parse().map_err(|_| io::Error::other("Invalid endpoint"))?, tcp });
    }}
    crate::linux_firewall::rules(&result, None)?; Ok(result)
}
fn update_protection(tunnel: &mut Tunnel, enabled: bool) -> io::Result<()> {
    if enabled == tunnel.protected { return Ok(()); }
    if enabled { if tunnel.connected && tunnel.interface.as_deref() != Some(TUNNEL) { return Err(io::Error::other("Verified tunnel unavailable")); } crate::linux_firewall::arm(&tunnel.endpoints, tunnel.interface.as_deref())?; }
    else { crate::linux_firewall::disarm()?; }
    tunnel.protected = enabled; Ok(())
}
fn connect(state: &Shared, generation: u64, id: &str, expires_at: u64, credentials: VpnCredentials, config: ValidatedConfig, stream: &mut UnixStream, deadline: Instant) -> io::Result<()> {
    let directory = Path::new(ROOT).join(format!("session-{generation}"));
    { let mut tunnel = locked(state)?; if tunnel.generation != generation { return Err(io::Error::other("Connection cancelled")); }
      fs::create_dir(&directory)?; fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?; tunnel.directory = Some(directory.clone()); }
    let config_path = directory.join("client.ovpn");
    OpenOptions::new().write(true).create_new(true).mode(0o600).open(&config_path)?.write_all(config.as_str().as_bytes())?;
    let management_path = directory.join("management.sock");
    let child = Command::new(OPENVPN).env_clear().env("PATH", "/usr/sbin:/usr/bin:/sbin:/bin")
        .args(["--config"]).arg(&config_path).args(["--dev", TUNNEL, "--management"]).arg(&management_path)
        .args(["unix", "--management-query-passwords", "--management-hold", "--redirect-gateway", "def1", "--verb", "3"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    { let mut tunnel = locked(state)?; tunnel.child = Some(child); tunnel.server = id.into(); }
    let mut channel = loop {
        if locked(state)?.generation != generation { return Err(io::Error::other("Connection cancelled")); }
        if let Ok(channel) = UnixStream::connect(&management_path) { break channel; }
        if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "OpenVPN timeout")); }
        if locked(state)?.child.as_mut().is_none_or(|child| child.try_wait().ok().flatten().is_some()) { return Err(io::Error::other("OpenVPN unavailable")); }
        thread::sleep(Duration::from_millis(50));
    };
    channel.set_read_timeout(Some(Duration::from_secs(1)))?; channel.set_write_timeout(Some(Duration::from_secs(2)))?;
    channel.write_all(b"state on\nlog on all\nbytecount 1\nhold release\n")?;
    locked(state)?.management = Some(channel.try_clone()?);
    let mut reader = BufReader::new(channel.try_clone()?); let mut dns = Vec::new(); let mut authenticated = false;
    loop {
        if locked(state)?.generation != generation { return Err(io::Error::other("Connection cancelled")); }
        if Instant::now() >= deadline || SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() >= expires_at { return Err(io::Error::new(io::ErrorKind::TimedOut, "OpenVPN timeout")); }
        let line = read_line(&mut reader, 8192)?; pushed_dns(&line, &mut dns);
        match management_event(&line) {
            ManagementEvent::AuthenticationRequested if !authenticated => { credentials.write_management_auth(&mut channel)?; authenticated = true; },
            ManagementEvent::AuthenticationRequested | ManagementEvent::AuthenticationFailed | ManagementEvent::Disconnected => return Err(io::Error::other("VPN authentication failed")),
            ManagementEvent::Connected => {
                verify_tunnel(&line)?; apply_dns(&dns)?;
                let mut tunnel = locked(state)?; if tunnel.generation != generation { return Err(io::Error::other("Connection cancelled")); }
                if tunnel.protected { crate::linux_firewall::arm(&tunnel.endpoints, Some(TUNNEL))?; }
                tunnel.interface = Some(TUNNEL.into()); tunnel.connected = true;
                tunnel.connected_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64; break;
            }, _ => {}
        }
    }
    status(state, stream)?;
    let state = Arc::clone(state); thread::spawn(move || loop {
        if SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() >= expires_at { stop_generation(&state, generation); return; }
        if locked(&state).map(|tunnel| tunnel.generation != generation).unwrap_or(true) { return; }
        let line = match read_line(&mut reader, 8192) { Ok(line) => line, Err(_) => { stop_generation(&state, generation); return; } };
        match management_event(&line) {
            ManagementEvent::Bytes { received, sent } => if let Ok(mut tunnel) = locked(&state) { if tunnel.generation == generation { tunnel.received = received; tunnel.sent = sent; } },
            ManagementEvent::Reconnecting | ManagementEvent::Disconnected | ManagementEvent::AuthenticationFailed | ManagementEvent::AuthenticationRequested => { stop_generation(&state, generation); return; }, _ => {}
        }
    }); Ok(())
}
fn peer_uid(stream: &UnixStream) -> io::Result<u32> {
    let mut value = UCred { pid: 0, uid: u32::MAX, gid: u32::MAX }; let mut length = std::mem::size_of::<UCred>() as u32;
    if unsafe { getsockopt(stream.as_raw_fd(), 1, 17, (&mut value as *mut UCred).cast(), &mut length) } != 0 || length as usize != std::mem::size_of::<UCred>() { return Err(io::Error::other("Peer identity unavailable")); }
    Ok(value.uid)
}
fn handle(mut stream: UnixStream, state: &Shared, allowed_uid: u32) -> io::Result<()> {
    if peer_uid(&stream)? != allowed_uid { return Err(io::Error::other("Access denied")); }
    stream.set_read_timeout(Some(Duration::from_secs(3)))?; stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut reader = BufReader::new(stream.try_clone()?); let header = read_line(&mut reader, 256)?;
    if header == "CAPABILITIES" { return stream.write_all(if crate::linux_firewall::available() { b"CAPABILITIES 3 kill-switch live-kill-switch\n" } else { b"CAPABILITIES 3\n" }); }
    if header == "STATUS" { return status(state, &mut stream); }
    if header == "EXPIRE" { stop(state)?; return status(state, &mut stream); }
    if matches!(header.as_str(), "PROTECT 0" | "PROTECT 1") {
        let _operation = CONNECT_LOCK.try_lock().map_err(|_| io::Error::other("Connection in progress"))?;
        let enabled = header == "PROTECT 1";
        let mut tunnel = locked(state)?;
        update_protection(&mut tunnel, enabled)?;
        return writeln!(stream, "PROTECTED {}", u8::from(enabled));
    }
    if header == "DISCONNECT" {
        let _operation = CONNECT_LOCK.lock().map_err(|_| io::Error::other("State unavailable"))?;
        let mut tunnel = locked(state)?; stop_inner(&mut tunnel)?; crate::linux_firewall::disarm()?; tunnel.protected = false; return stream.write_all(b"DISCONNECTED\n");
    }
    let fields = header.split(' ').collect::<Vec<_>>();
    if !matches!(fields.len(), 6 | 7 | 8) || fields[0] != "CONNECT" || fields[1].is_empty() || fields[1].len() > 64 || !fields[1].bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-') { return Err(io::Error::other("Invalid request")); }
    let credentials = VpnCredentials::new(fields[2].into(), fields[3].into()).map_err(|_| io::Error::other("Invalid authentication"))?;
    let expires_at = fields[4].parse::<u64>().map_err(|_| io::Error::other("Invalid expiry"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs(); if expires_at <= now || expires_at.saturating_sub(now) > 7 * 86400 { return Err(io::Error::other("Session expired")); }
    let size = fields[5].parse::<usize>().ok().filter(|value| (1..=131072).contains(value)).ok_or_else(|| io::Error::other("Invalid config size"))?;
    let protect = match fields.get(6) { None | Some(&"0") => false, Some(&"1") => true, _ => return Err(io::Error::other("Invalid protection mode")) };
    let budget = fields.get(7).map_or(Some(30_000), |value| value.parse::<u64>().ok().filter(|value| (1..=30_000).contains(value))).ok_or_else(|| io::Error::other("Invalid timeout"))?;
    let id = fields[1].to_owned(); drop(fields);
    let mut raw = vec![0; size]; reader.read_exact(&mut raw)?;
    let config = ValidatedConfig::parse(std::str::from_utf8(&raw).map_err(|_| io::Error::other("Invalid config"))?).map_err(|_| io::Error::other("Unsupported config"))?; raw.fill(0);
    let _operation = CONNECT_LOCK.lock().map_err(|_| io::Error::other("State unavailable"))?;
    let allowed = if protect { endpoints(&config)? } else { endpoints(&config).unwrap_or_default() };
    let generation = { let mut tunnel = locked(state)?; stop_inner(&mut tunnel)?; if protect { crate::linux_firewall::arm(&allowed, None)?; } else { crate::linux_firewall::disarm()?; } tunnel.protected = protect; tunnel.endpoints = allowed; tunnel.generation };
    if let Err(error) = connect(state, generation, &id, expires_at, credentials, config, &mut stream, Instant::now() + Duration::from_millis(budget)) {
        stop_generation(state, generation); stream.write_all(if error.kind() == io::ErrorKind::TimedOut { b"ERROR timeout\n" } else { b"ERROR connection_failed\n" })?;
    } Ok(())
}
pub fn run() -> io::Result<()> {
    if unsafe { geteuid() } != 0 { return Err(io::Error::other("System helper requires root")); }
    if std::env::args().nth(1).as_deref() == Some("--unblock") { return crate::linux_firewall::disarm(); }
    let uid = std::env::args().nth(1).and_then(|value| value.parse::<u32>().ok()).filter(|value| *value >= 1000).ok_or_else(|| io::Error::other("Missing allowed user"))?;
    for path in [OPENVPN, "/usr/sbin/ip", RESOLVECTL, "/usr/sbin/nft"] { let meta = fs::symlink_metadata(path)?; if !meta.is_file() || meta.file_type().is_symlink() || meta.uid() != 0 || meta.mode() & 0o022 != 0 { return Err(io::Error::other("Unsafe runtime ownership")); } }
    if !Path::new(ROOT).exists() { fs::create_dir(ROOT)?; }
    let root = fs::symlink_metadata(ROOT)?; if !root.is_dir() || root.file_type().is_symlink() || root.uid() != 0 { return Err(io::Error::other("Unsafe runtime directory")); }
    fs::set_permissions(ROOT, fs::Permissions::from_mode(0o755))?;
    if Path::new(SOCKET).exists() { fs::remove_file(SOCKET)?; }
    let listener = UnixListener::bind(SOCKET)?; listener.set_nonblocking(true)?; fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o600))?;
    let socket = std::ffi::CString::new(SOCKET).unwrap(); if unsafe { chown(socket.as_ptr(), uid, u32::MAX) } != 0 { return Err(io::Error::other("Socket permissions unavailable")); }
    clear_dns();
    let state = Arc::new(Mutex::new(Tunnel { protected: crate::linux_firewall::is_armed(), ..Tunnel::default() }));
    unsafe { signal(15, shutdown_signal as *const () as usize); signal(2, shutdown_signal as *const () as usize); }
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    while !SHUTDOWN.load(std::sync::atomic::Ordering::Relaxed) {
        let stream = match listener.accept() { Ok((stream, _)) => stream, Err(error) if error.kind() == io::ErrorKind::WouldBlock => { thread::sleep(Duration::from_millis(50)); continue; }, Err(error) => return Err(error) };
        use std::sync::atomic::Ordering; if active.fetch_add(1, Ordering::SeqCst) >= 8 { active.fetch_sub(1, Ordering::SeqCst); continue; }
        let state = Arc::clone(&state); let active = Arc::clone(&active); thread::spawn(move || { let _ = handle(stream, &state, uid); active.fetch_sub(1, Ordering::SeqCst); });
    }
    stop(&state)?; crate::linux_firewall::disarm()
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn dns_parser_accepts_only_bounded_addresses_from_push_reply() { let mut values = Vec::new(); pushed_dns(">LOG:1,N,PUSH_REPLY,dhcp-option DNS 10.8.0.1,dhcp-option DNS bad;command", &mut values); assert_eq!(values, vec!["10.8.0.1".parse::<IpAddr>().unwrap()]); }
    #[test] fn lines_are_bounded() { assert_eq!(read_line(&mut io::Cursor::new(b"STATUS\n"), 256).unwrap(), "STATUS"); assert!(read_line(&mut io::Cursor::new(b"TOO-LONG\n"), 3).is_err()); }
}
