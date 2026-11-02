//! Own anchor/reference only: never reload the root ruleset or disable PF globally.
use std::{fs::{self, OpenOptions}, io::{self, Read, Write}, os::unix::fs::{MetadataExt, OpenOptionsExt}, path::Path, process::{Command, Stdio}, time::{Duration, Instant}};
use crate::firewall::{self, Endpoint, ANCHOR};
const TOKEN: &str = "/var/run/stellar-vpn/pf-token";
// The passed installation test survives an OS reboot. Runtime PF references
// remain ephemeral; root rules are independently rechecked on every arm().
const VERIFIED: &str = "/Library/Application Support/Stellar VPN/firewall-verified-v1";
pub fn verified() -> bool {
    fs::symlink_metadata(VERIFIED).is_ok_and(|meta| meta.uid() == 0 && meta.is_file() && !meta.file_type().is_symlink() && meta.mode() & 0o022 == 0)
}
pub fn self_test() -> io::Result<()> {
    if token()?.is_some() { return Err(io::Error::other("Disconnect the active protected tunnel before testing")); }
    if Path::new(VERIFIED).exists() {
        if !verified() { return Err(io::Error::other("Unsafe firewall verification record")); }
        fs::remove_file(VERIFIED)?;
    }
    let mut probe = crate::macos_probe::Probe::new()?;
    for ipv6 in [false, true] { for port in [9000, 53] {
        if !probe.observed(ipv6, port)? { return Err(io::Error::other("Local IPv4/IPv6 baseline failed; no firewall changes made")); }
    } }
    struct Restore;
    impl Drop for Restore { fn drop(&mut self) { let _ = disarm(); } }
    let restore = Restore;
    let endpoints = [Endpoint { ip: "203.0.113.10".parse().unwrap(), port: 1197, tcp: false }];
    arm(&endpoints, Some(&probe.name))?;
    for ipv6 in [false, true] { if !probe.observed(ipv6, 9000)? { return Err(io::Error::other("Tunnel allow rule failed")); } }
    arm(&endpoints, None)?;
    for ipv6 in [false, true] { for port in [9000, 53] {
        if probe.observed(ipv6, port)? { return Err(io::Error::other("Local firewall leak detected")); }
    } }
    disarm()?; std::mem::forget(restore);
    for ipv6 in [false, true] { if !probe.observed(ipv6, 9000)? { return Err(io::Error::other("Local network restoration failed")); } }
    let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).open(VERIFIED)?;
    file.write_all(b"1")?; file.sync_all()?;
    println!("Stellar local firewall test: IPv4/IPv6 and DNS blocked, tunnel allowed, routing restored. External-network leak tests still required.");
    Ok(())
}
fn command(args: &[&str], input: &str) -> io::Result<String> {
    let mut child = Command::new("/sbin/pfctl").env_clear().args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let out = child.stdout.take().unwrap(); let err = child.stderr.take().unwrap();
    let output = std::thread::spawn(move || { let mut data = Vec::new(); let result = out.take(65536).read_to_end(&mut data); (result, data) });
    let errors = std::thread::spawn(move || { let mut data = Vec::new(); let result = err.take(65536).read_to_end(&mut data); (result, data) });
    if let Some(mut stdin) = child.stdin.take() { stdin.write_all(input.as_bytes())?; }
    let deadline = Instant::now() + Duration::from_secs(2);
    let success = loop {
        if let Some(status) = child.try_wait()? { break status.success(); }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(io::Error::new(io::ErrorKind::TimedOut, "Firewall command timed out")); }
        std::thread::sleep(Duration::from_millis(10));
    };
    let (read_out, mut data) = output.join().map_err(|_| io::Error::other("Firewall output unavailable"))?;
    let (read_err, errors) = errors.join().map_err(|_| io::Error::other("Firewall output unavailable"))?;
    read_out?; read_err?;
    if !success || data.len() >= 65536 || errors.len() >= 65536 { return Err(io::Error::other("Firewall command failed")); }
    data.extend(errors); String::from_utf8(data).map_err(|_| io::Error::other("Invalid firewall output"))
}
fn token() -> io::Result<Option<String>> {
    if !Path::new(TOKEN).exists() { return Ok(None); }
    let meta = fs::symlink_metadata(TOKEN)?;
    if meta.uid() != 0 || meta.mode() & 0o077 != 0 || !meta.is_file() || meta.file_type().is_symlink() || meta.len() > 32 { return Err(io::Error::other("Unsafe firewall token")); }
    let value = fs::read_to_string(TOKEN)?;
    if value.is_empty() || !value.bytes().all(|c| c.is_ascii_digit()) { return Err(io::Error::other("Invalid firewall token")); } Ok(Some(value))
}
pub fn arm(endpoints: &[Endpoint], interface: Option<&str>) -> io::Result<()> {
    let root = command(&["-sr"], "")?;
    let root = root.lines().filter(|line| !line.starts_with("No ALTQ") && !line.starts_with("ALTQ")).collect::<Vec<_>>().join("\n");
    if !firewall::compatible_root_rules(&root) {
        // Diagnostic only: list anchor names, never rule addresses or packet data.
        let anchors = root.lines().filter(|line| line.starts_with("anchor ")).map(|line| line.split('"').nth(1).unwrap_or("unknown")).take(8).collect::<Vec<_>>().join(", ");
        return Err(io::Error::other(format!("Custom system firewall is incompatible ({} lines; anchors: {anchors})", root.lines().count())));
    }
    let rules = firewall::rules(endpoints, interface)?;
    command(&["-a", ANCHOR, "-nf", "-"], &rules)?;
    command(&["-a", ANCHOR, "-f", "-"], &rules)?;
    if token()?.is_none() {
        let output = command(&["-E"], "")?;
        let reference = output.lines().find_map(|line| line.trim().strip_prefix("Token :").or_else(|| line.trim().strip_prefix("Token:"))).map(str::trim)
            .filter(|value| !value.is_empty() && value.len() <= 32 && value.bytes().all(|c| c.is_ascii_digit())).ok_or_else(|| io::Error::other("Firewall reference unavailable"))?;
        if let Err(error) = OpenOptions::new().create_new(true).write(true).mode(0o600).open(TOKEN).and_then(|mut file| { file.write_all(reference.as_bytes())?; file.sync_all() }) {
            let _ = command(&["-X", reference], ""); return Err(error);
        }
    }
    // Preexisting states bypass new rules. User approved resetting connections.
    command(&["-k", "0.0.0.0/0"], "")?; command(&["-k", "::/0"], "")?;
    let loaded = command(&["-a", ANCHOR, "-sr"], "")?;
    if !loaded.lines().any(|line| line.trim() == "block drop out quick all") { return Err(io::Error::other("Firewall verification failed")); } Ok(())
}
pub fn disarm() -> io::Result<()> {
    command(&["-a", ANCHOR, "-F", "rules"], "")?;
    if let Some(reference) = token()? { command(&["-X", &reference], "")?; fs::remove_file(TOKEN)?; } Ok(())
}
