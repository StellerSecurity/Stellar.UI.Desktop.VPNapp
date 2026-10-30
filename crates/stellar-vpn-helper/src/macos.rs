//! Narrow root helper: no arbitrary executable, file path, shell or plugin requests.
use std::{fs::{self, OpenOptions}, io::{self, BufRead, BufReader, Read, Write}, os::{fd::AsRawFd, unix::{fs::{MetadataExt, OpenOptionsExt, PermissionsExt}, net::{UnixListener, UnixStream}}},
    path::{Path, PathBuf}, process::{Child, Command, Stdio}, sync::{Arc, Mutex}, thread, time::{Duration, Instant, SystemTime, UNIX_EPOCH}};
use stellar_core::openvpn::{ValidatedConfig, VpnCredentials, ManagementEvent, management_event};
const ROOT: &str = "/var/run/stellar-vpn";
const SOCKET: &str = "/var/run/stellar-vpn/helper.sock";
const RUNTIME: &str = "/Library/Application Support/Stellar VPN/Runtime/openvpn";
const DNS_KEY: &str = "State:/Network/Service/org.stellarvpn.desktop/DNS";
static CONNECT_LOCK: Mutex<()> = Mutex::new(());
static SHUTDOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
extern "C" fn shutdown_signal(_: i32) { SHUTDOWN.store(true, std::sync::atomic::Ordering::Relaxed); }
unsafe extern "C" { fn geteuid() -> u32; fn getpeereid(fd: i32, euid: *mut u32, egid: *mut u32) -> i32; fn chown(path: *const i8, uid: u32, gid: u32) -> i32; fn signal(sig: i32, handler: usize) -> usize; }
#[derive(Default)]
struct Tunnel { child: Option<Child>, management: Option<UnixStream>, generation: u64, connected: bool, server: String, connected_at: u64, received: u64, sent: u64, directory: Option<PathBuf>, protected: bool, endpoints: Vec<crate::firewall::Endpoint> }
type Shared = Arc<Mutex<Tunnel>>;
fn locked(state: &Shared) -> io::Result<std::sync::MutexGuard<'_, Tunnel>> { state.lock().map_err(|_| io::Error::other("State unavailable")) }
fn scutil(input: &str) -> io::Result<()> {
    let mut child = Command::new("/usr/sbin/scutil").env_clear().stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    child.stdin.take().ok_or_else(|| io::Error::other("DNS unavailable"))?.write_all(input.as_bytes())?;
    if !child.wait()?.success() { return Err(io::Error::other("DNS unavailable")); } Ok(())
}
fn clear_dns() { let _ = scutil(&format!("remove {DNS_KEY}\nquit\n")); }
fn apply_dns(servers: &[std::net::IpAddr]) -> io::Result<()> {
    if servers.is_empty() || servers.len() > 4 { return Err(io::Error::other("VPN DNS unavailable")); }
    let addresses = servers.iter().map(ToString::to_string).collect::<Vec<_>>().join(" ");
    scutil(&format!("d.init\nd.add ServerAddresses * {addresses}\nd.add SupplementalMatchDomains * \"\"\nd.add SupplementalMatchDomainsNoSearch # 1\nset {DNS_KEY}\nquit\n"))?;
    let mut child = Command::new("/usr/sbin/scutil").env_clear().stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    child.stdin.take().ok_or_else(|| io::Error::other("DNS unavailable"))?.write_all(format!("show {DNS_KEY}\nquit\n").as_bytes())?;
    let output = child.wait_with_output()?;
    let installed = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !installed.contains("ServerAddresses") || !installed.contains("SupplementalMatchDomains")
        || !servers.iter().all(|ip| installed.lines().any(|line| line.split_once(" : ").is_some_and(|(_, value)| value.trim() == ip.to_string()))) {
        return Err(io::Error::other("VPN DNS verification failed"));
    }
    Ok(())
}
fn verify_tunnel(line: &str) -> io::Result<String> {
    let address = line.strip_prefix(">STATE:").and_then(|s| s.split(',').nth(3))
        .and_then(|s| s.parse::<std::net::Ipv4Addr>().ok()).filter(|ip| !ip.is_unspecified())
        .ok_or_else(|| io::Error::other("VPN address unavailable"))?;
    let route = Command::new("/sbin/route").env_clear().args(["-n", "get", "1.1.1.1"]).output()?;
    let text = String::from_utf8_lossy(&route.stdout);
    let interface = text.lines().find_map(|line| line.trim().strip_prefix("interface:").map(str::trim))
        .filter(|name| name.strip_prefix("utun").is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())))
        .ok_or_else(|| io::Error::other("VPN route unavailable"))?;
    let network = Command::new("/sbin/ifconfig").env_clear().arg(interface).output()?;
    if !route.status.success() || !network.status.success() || !String::from_utf8_lossy(&network.stdout).lines().any(|line| {
        let mut fields = line.split_whitespace(); fields.next() == Some("inet") && fields.next() == Some(address.to_string().as_str())
    }) { return Err(io::Error::other("VPN interface verification failed")); }
    Ok(interface.into())
}
fn stop_inner(tunnel: &mut Tunnel) -> io::Result<()> {
    if tunnel.protected { crate::macos_firewall::arm(&tunnel.endpoints, None)?; }
    tunnel.generation = tunnel.generation.wrapping_add(1); tunnel.connected = false;
    if let Some(mut management) = tunnel.management.take() { let _ = management.write_all(b"signal SIGTERM\n"); }
    if let Some(mut child) = tunnel.child.take() {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline { if child.try_wait()?.is_some() { break; } thread::sleep(Duration::from_millis(50)); }
        if child.try_wait()?.is_none() { child.kill()?; }
        let _ = child.wait();
    }
    // Runtime directory is helper-created, root-owned and never renderer-provided.
    if let Some(dir) = tunnel.directory.take() { let _ = fs::remove_file(dir.join("client.ovpn")); let _ = fs::remove_file(dir.join("management.sock")); let _ = fs::remove_dir(dir); }
    clear_dns(); Ok(())
}
fn stop(state: &Shared) -> io::Result<()> { let mut tunnel = locked(state)?; stop_inner(&mut tunnel) }
fn stop_generation(state: &Shared, generation: u64) {
    if let Ok(mut tunnel) = locked(state) { if tunnel.generation == generation { let _ = stop_inner(&mut tunnel); } }
}
fn status(state: &Shared, stream: &mut UnixStream) -> io::Result<()> {
    let tunnel = locked(state)?;
    if tunnel.connected { writeln!(stream, "CONNECTED {} {} {} {}", tunnel.server, tunnel.connected_at, tunnel.received, tunnel.sent) }
    else if tunnel.protected { stream.write_all(b"BLOCKED\n") }
    else { stream.write_all(b"DISCONNECTED\n") }
}
fn pushed_dns(line: &str, dns: &mut Vec<std::net::IpAddr>) {
    if !line.starts_with(">LOG:") || !line.contains("PUSH_REPLY,") { return; }
    for part in line.split(',') {
        let Some(address) = part.trim().strip_prefix("dhcp-option DNS ") else { continue; };
        if let Ok(ip) = address.trim_end_matches('\'').parse::<std::net::IpAddr>() {
            if !ip.is_unspecified() && !ip.is_multicast() && !dns.contains(&ip) && dns.len() < 4 { dns.push(ip); }
        }
    }
}
fn connect(state: &Shared, generation: u64, id: &str, expires_at: u64, credentials: VpnCredentials, config: ValidatedConfig, stream: &mut UnixStream, deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "OpenVPN timeout")); }
    let dir = Path::new(ROOT).join(format!("session-{generation}"));
    let mut tunnel = locked(state)?;
    if tunnel.generation != generation || SHUTDOWN.load(std::sync::atomic::Ordering::Relaxed) { return Err(io::Error::other("Connection cancelled")); }
    fs::create_dir(&dir)?; fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    tunnel.directory = Some(dir.clone());
    let config_path = dir.join("client.ovpn");
    OpenOptions::new().write(true).create_new(true).mode(0o600).open(&config_path)?.write_all(config.as_str().as_bytes())?;
    let management_path = dir.join("management.sock");
    let child = Command::new(RUNTIME).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("OPENSSL_CONF", "/dev/null").env("OPENSSL_MODULES", "/Library/Application Support/Stellar VPN/Runtime/ossl-modules")
        .arg("--config").arg(config_path).arg("--management").arg(&management_path).arg("unix")
        .args(["--management-query-passwords", "--management-hold", "--redirect-gateway", "def1", "--verb", "3"])
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    tunnel.child = Some(child); tunnel.server = id.into();
    drop(tunnel);
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
    let mut reader = BufReader::new(channel.try_clone()?);
    let mut dns = Vec::new(); let mut authenticated = false;
    loop {
        if locked(state)?.generation != generation { return Err(io::Error::other("Connection cancelled")); }
        if Instant::now() >= deadline || SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() >= expires_at { return Err(io::Error::new(io::ErrorKind::TimedOut, "OpenVPN timeout")); }
        let line = read_line(&mut reader, 8192)?;
        pushed_dns(&line, &mut dns);
        match management_event(&line) {
            ManagementEvent::AuthenticationRequested if !authenticated => { credentials.write_management_auth(&mut channel)?; authenticated = true; }
            ManagementEvent::AuthenticationRequested | ManagementEvent::AuthenticationFailed | ManagementEvent::Disconnected => return Err(io::Error::other("VPN authentication failed")),
            ManagementEvent::Connected => {
                let interface = verify_tunnel(&line)?;
                let mut tunnel = locked(state)?;
                if tunnel.generation != generation { return Err(io::Error::other("Connection cancelled")); }
                apply_dns(&dns)?;
                if tunnel.protected { crate::macos_firewall::arm(&tunnel.endpoints, Some(&interface))?; }
                if Instant::now() >= deadline { return Err(io::Error::new(io::ErrorKind::TimedOut, "OpenVPN timeout")); }
                tunnel.connected = true; tunnel.connected_at = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                break;
            }
            _ => {}
        }
    }
    drop(credentials);
    status(state, stream)?;
    let state = Arc::clone(state);
    thread::spawn(move || {
        loop {
            if SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() >= expires_at { break; }
            if locked(&state).map(|t| t.generation != generation).unwrap_or(true) { return; }
            let line = match read_line(&mut reader, 8192) { Ok(line) => line, Err(_) => break };
            match management_event(&line) {
                ManagementEvent::Bytes { received, sent } => { if let Ok(mut tunnel) = locked(&state) { if tunnel.generation != generation { return; } tunnel.received = received; tunnel.sent = sent; } }
                ManagementEvent::Reconnecting | ManagementEvent::Disconnected | ManagementEvent::AuthenticationFailed | ManagementEvent::AuthenticationRequested => break,
                _ => {}
            }
        }
        stop_generation(&state, generation);
    });
    Ok(())
}
// Bounded newline protocol; no logs or debug dumps of raw requests/management data.
fn read_line(reader: &mut impl BufRead, max: usize) -> io::Result<String> {
    let mut bytes = Vec::new();
    loop {
        let mut byte = [0u8];
        match reader.read_exact(&mut byte) {
            Ok(()) if byte[0] == b'\n' => break,
            Ok(()) => { bytes.push(byte[0]); if bytes.len() > max { return Err(io::Error::other("Message too large")); } }
            Err(error) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) && bytes.is_empty() => return Ok(String::new()),
            Err(error) => return Err(error),
        }
    }
    String::from_utf8(bytes).map(|s| s.trim_end_matches('\r').to_owned()).map_err(|_| io::Error::other("Invalid message"))
}
fn handle(mut stream: UnixStream, state: &Shared, uid: u32) -> io::Result<()> {
    let (mut peer, mut gid) = (u32::MAX, u32::MAX);
    if unsafe { getpeereid(stream.as_raw_fd(), &mut peer, &mut gid) } != 0 || peer != uid { return Err(io::Error::other("Access denied")); }
    stream.set_read_timeout(Some(Duration::from_secs(3)))?; stream.set_write_timeout(Some(Duration::from_secs(3)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let header = read_line(&mut reader, 256)?;
    if header == "CAPABILITIES" { return stream.write_all(if crate::macos_firewall::verified() { b"CAPABILITIES 2 kill-switch\n" } else { b"CAPABILITIES 2\n" }); }
    if header == "STATUS" { return status(state, &mut stream); }
    if header == "EXPIRE" { stop(state)?; return status(state, &mut stream); }
    #[cfg(debug_assertions)]
    if header == "TEST_LOSS" {
        // Explicit development fault injection into the owned tunnel only.
        // No frontend IPC exposes this; release builds omit it entirely.
        let mut tunnel = locked(state)?;
        if !tunnel.connected { return Err(io::Error::other("No active tunnel to test")); }
        tunnel.management.as_mut().ok_or_else(|| io::Error::other("Management unavailable"))?.write_all(b"signal SIGUSR1\n")?;
        return stream.write_all(b"TEST_STARTED\n");
    }
    if header == "DISCONNECT" {
        stop(state)?; crate::macos_firewall::disarm()?;
        locked(state)?.protected = false;
        return stream.write_all(b"DISCONNECTED\n");
    }
    let fields: Vec<_> = header.split(' ').collect();
    if !matches!(fields.len(), 6 | 7 | 8) || fields[0] != "CONNECT" || fields[1].is_empty() || fields[1].len() > 64
        || !fields[1].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return Err(io::Error::other("Invalid request")); }
    let credentials = VpnCredentials::new(fields[2].into(), fields[3].into()).map_err(|_| io::Error::other("Invalid authentication"))?;
    let expires_at = fields[4].parse::<u64>().map_err(|_| io::Error::other("Invalid expiry"))?;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
    if expires_at <= now || expires_at.saturating_sub(now) > 7 * 86400 { return Err(io::Error::other("Session expired")); }
    let size = fields[5].parse::<usize>().map_err(|_| io::Error::other("Invalid request"))?;
    if size == 0 || size > 131072 { return Err(io::Error::other("Invalid config size")); }
    let id = fields[1].to_owned();
    let protect = match fields.get(6) { None | Some(&"0") => false, Some(&"1") => true, _ => return Err(io::Error::other("Invalid protection mode")) };
    let budget = match fields.get(7) {
        None => 30_000,
        Some(value) => value.parse::<u64>().ok().filter(|value| (1..=30_000).contains(value)).ok_or_else(|| io::Error::other("Invalid connection timeout"))?,
    };
    let deadline = Instant::now() + Duration::from_millis(budget);
    if protect && !crate::macos_firewall::verified() { return Err(io::Error::other("Firewall has not passed system verification")); }
    drop(fields);
    let mut raw_header = header.into_bytes();
    for byte in &mut raw_header { unsafe { std::ptr::write_volatile(byte, 0) }; }
    let mut raw = vec![0; size]; reader.read_exact(&mut raw)?;
    let config = ValidatedConfig::parse(std::str::from_utf8(&raw).map_err(|_| io::Error::other("Invalid config"))?).map_err(|_| io::Error::other("Unsupported config"))?;
    raw.fill(0);
    let _operation = CONNECT_LOCK.lock().map_err(|_| io::Error::other("State unavailable"))?;
    // Protected connections require literal endpoints: no DNS exception can
    // accidentally permit unrelated lookups outside the tunnel.
    let endpoints = if protect { firewall_endpoints(&config)? } else { Vec::new() };
    let generation = {
        let mut tunnel = locked(state)?; stop_inner(&mut tunnel)?;
        if protect { crate::macos_firewall::arm(&endpoints, None)?; }
        else { crate::macos_firewall::disarm()?; }
        tunnel.protected = protect; tunnel.endpoints = endpoints; tunnel.generation
    };
    if let Err(error) = connect(state, generation, &id, expires_at, credentials, config, &mut stream, deadline) {
        stop_generation(state, generation);
        stream.write_all(if error.kind() == io::ErrorKind::TimedOut { b"ERROR timeout\n" } else { b"ERROR connection_failed\n" })?;
    }
    Ok(())
}
pub fn run() -> io::Result<()> {
    if unsafe { geteuid() } != 0 { return Err(io::Error::other("System helper requires root")); }
    if std::env::args().nth(1).as_deref() == Some("--unblock") { return crate::macos_firewall::disarm(); }
    if std::env::args().nth(1).as_deref() == Some("--firewall-test") {
        let result = crate::macos_firewall::self_test();
        let outcome = if result.is_ok() { "passed" } else { "not_verified" };
        OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open("/var/run/stellar-vpn/firewall-test-result")?.write_all(outcome.as_bytes())?;
        if let Err(error) = &result { eprintln!("Stellar firewall self-test: {error}"); }
        return result;
    }
    let uid = std::env::args().nth(1).and_then(|s| s.parse::<u32>().ok()).filter(|uid| *uid >= 501).ok_or_else(|| io::Error::other("Missing allowed user"))?;
    for path in ["/Library/Application Support/Stellar VPN", "/Library/Application Support/Stellar VPN/Runtime", RUNTIME] {
        let meta = fs::symlink_metadata(path)?;
        if meta.uid() != 0 || meta.mode() & 0o022 != 0 || meta.file_type().is_symlink() { return Err(io::Error::other("Unsafe runtime ownership")); }
    }
    if !Path::new(ROOT).exists() { fs::create_dir(ROOT)?; }
    let meta = fs::symlink_metadata(ROOT)?;
    if meta.uid() != 0 || meta.file_type().is_symlink() { return Err(io::Error::other("Unsafe runtime directory")); }
    fs::set_permissions(ROOT, fs::Permissions::from_mode(0o755))?;
    // Only our previous root-owned session files; never recursive deletion or caller paths.
    for entry in fs::read_dir(ROOT)?.flatten() {
        let name = entry.file_name(); let name = name.to_string_lossy();
        if !name.strip_prefix("session-").is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())) { continue; }
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.uid() != 0 || !meta.is_dir() || meta.file_type().is_symlink() { continue; }
        for file in ["client.ovpn", "management.sock"] { let _ = fs::remove_file(entry.path().join(file)); }
        let _ = fs::remove_dir(entry.path());
    }
    if Path::new(SOCKET).exists() { fs::remove_file(SOCKET)?; }
    let listener = UnixListener::bind(SOCKET)?;
    listener.set_nonblocking(true)?;
    fs::set_permissions(SOCKET, fs::Permissions::from_mode(0o600))?;
    let socket_path = std::ffi::CString::new(SOCKET).unwrap();
    if unsafe { chown(socket_path.as_ptr(), uid, u32::MAX) } != 0 { return Err(io::Error::other("Socket permissions unavailable")); }
    clear_dns();
    let state = Arc::new(Mutex::new(Tunnel::default()));
    // launchctl bootout/update must restore DNS and stop the owned tunnel.
    unsafe { signal(15, shutdown_signal as *const () as usize); signal(2, shutdown_signal as *const () as usize); }
    // A separate status/disconnect request can interrupt a slow connection attempt.
    let active = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    while !SHUTDOWN.load(std::sync::atomic::Ordering::Relaxed) {
        let stream = match listener.accept() {
            Ok((stream, _)) => stream,
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => { thread::sleep(Duration::from_millis(50)); continue; }
            Err(error) => return Err(error),
        };
        use std::sync::atomic::Ordering;
        if active.fetch_add(1, Ordering::SeqCst) >= 8 { active.fetch_sub(1, Ordering::SeqCst); continue; }
        let state = Arc::clone(&state); let active = Arc::clone(&active);
        thread::spawn(move || { let _ = handle(stream, &state, uid); active.fetch_sub(1, Ordering::SeqCst); });
    }
    stop(&state)?;
    crate::macos_firewall::disarm()
}

fn firewall_endpoints(config: &ValidatedConfig) -> io::Result<Vec<crate::firewall::Endpoint>> {
    let tcp = config.as_str().lines().any(|line| line == "proto tcp-client" || line == "proto tcp4-client");
    let mut endpoints = Vec::new();
    for line in config.as_str().lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if let ["remote", address, port] = fields.as_slice() {
            endpoints.push(crate::firewall::Endpoint {
                ip: address.parse().map_err(|_| io::Error::other("Kill switch requires a literal VPN endpoint"))?,
                port: port.parse().map_err(|_| io::Error::other("Invalid endpoint port"))?, tcp,
            });
        }
    }
    crate::firewall::rules(&endpoints, None)?; Ok(endpoints)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dns_accepts_only_bounded_ip_addresses_from_push_reply() {
        let mut dns = Vec::new();
        pushed_dns(">LOG:123,N,PUSH: Received control message: 'PUSH_REPLY,dhcp-option DNS 10.8.0.1,dhcp-option DNS 10.8.0.1,dhcp-option DNS bad;command'", &mut dns);
        assert_eq!(dns, vec!["10.8.0.1".parse::<std::net::IpAddr>().unwrap()]);
        pushed_dns("dhcp-option DNS 1.2.3.4", &mut dns);
        assert_eq!(dns.len(), 1);
    }
    #[test]
    fn request_lines_are_bounded_and_invalid_utf8_is_rejected() {
        assert_eq!(read_line(&mut io::Cursor::new(b"STATUS\n"), 256).unwrap(), "STATUS");
        assert!(read_line(&mut io::Cursor::new(b"TOO-LONG\n"), 3).is_err());
        assert!(read_line(&mut io::Cursor::new([255, 10]), 256).is_err());
    }
}
