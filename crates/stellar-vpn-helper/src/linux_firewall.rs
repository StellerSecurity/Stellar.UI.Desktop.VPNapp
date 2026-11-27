//! Linux kill switch isolated in one owned nftables table.
use std::{io, process::{Command, Stdio}};
use crate::firewall::Endpoint;

const NFT: &str = "/usr/sbin/nft";
const TABLE: &str = "stellar_vpn";

fn interface(value: &str) -> io::Result<&str> {
    if value == "stellar0" { Ok(value) } else { Err(io::Error::other("Invalid tunnel interface")) }
}

pub fn rules(endpoints: &[Endpoint], tunnel: Option<&str>) -> io::Result<String> {
    crate::firewall::rules(endpoints, None)?;
    let mut value = format!("table inet {TABLE} {{\n chain output {{\n  type filter hook output priority -100; policy drop;\n  oifname \"lo\" accept\n");
    if let Some(name) = tunnel { value.push_str(&format!("  oifname \"{}\" accept\n", interface(name)?)); }
    for endpoint in endpoints {
        let family = if endpoint.ip.is_ipv4() { "ip" } else { "ip6" };
        let protocol = if endpoint.tcp { "tcp" } else { "udp" };
        value.push_str(&format!("  {family} daddr {} {protocol} dport {} accept\n", endpoint.ip, endpoint.port));
    }
    value.push_str("  reject\n }\n}\n");
    Ok(value)
}

fn run(args: &[&str], input: Option<&str>) -> io::Result<String> {
    let mut child = Command::new(NFT).env_clear().args(args)
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    if let Some(value) = input {
        use std::io::Write;
        child.stdin.take().ok_or_else(|| io::Error::other("Firewall input unavailable"))?.write_all(value.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    if !output.status.success() || output.stdout.len() > 65_536 || output.stderr.len() > 65_536 {
        return Err(io::Error::other("Firewall operation failed"));
    }
    String::from_utf8(output.stdout).map_err(|_| io::Error::other("Invalid firewall output"))
}

pub fn available() -> bool {
    std::fs::symlink_metadata(NFT).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink())
}

pub fn is_armed() -> bool {
    run(&["list", "table", "inet", TABLE], None).is_ok_and(|loaded| {
        loaded.contains("hook output priority -100; policy drop;")
            && loaded.contains("oifname \"lo\" accept")
            && loaded.contains("reject")
    })
}

pub fn arm(endpoints: &[Endpoint], tunnel: Option<&str>) -> io::Result<()> {
    if !available() { return Err(io::Error::other("nftables unavailable")); }
    let _ = run(&["delete", "table", "inet", TABLE], None);
    let expected = rules(endpoints, tunnel)?;
    run(&["-f", "-"], Some(&expected))?;
    let loaded = run(&["list", "table", "inet", TABLE], None)?;
    if !loaded.contains("hook output priority -100; policy drop;")
        || !loaded.contains("oifname \"lo\" accept") || !loaded.contains("reject") {
        let _ = disarm();
        return Err(io::Error::other("Firewall verification failed"));
    }
    if let Some(name) = tunnel { if !loaded.contains(&format!("oifname \"{}\" accept", interface(name)?)) { let _ = disarm(); return Err(io::Error::other("Tunnel firewall verification failed")); } }
    Ok(())
}

pub fn disarm() -> io::Result<()> {
    if !available() { return Ok(()); }
    match run(&["delete", "table", "inet", TABLE], None) {
        Ok(_) => Ok(()),
        Err(_) if run(&["list", "table", "inet", TABLE], None).is_err() => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn endpoint() -> Endpoint { Endpoint { ip: "203.0.113.10".parse().unwrap(), port: 1197, tcp: false } }
    #[test] fn preconnect_allows_only_loopback_and_literal_endpoint() {
        let value = rules(&[endpoint()], None).unwrap();
        assert!(value.contains("policy drop") && value.contains("ip daddr 203.0.113.10 udp dport 1197 accept"));
        assert!(!value.contains("stellar0") && !value.contains("port 53"));
    }
    #[test] fn connected_rules_allow_only_the_fixed_verified_tunnel() {
        assert!(rules(&[endpoint()], Some("stellar0")).unwrap().contains("oifname \"stellar0\" accept"));
        for value in ["tun0", "stellar0\naccept", "eth0"] { assert!(rules(&[endpoint()], Some(value)).is_err()); }
    }
}
