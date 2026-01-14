// src-tauri/bin/stellar-vpn-helper.rs
use std::{
    env, fs,
    io::Write,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    process::{Command, Stdio},
};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
}

fn resolve_host(host: &str, port: u16) -> Vec<IpAddr> {
    let addr = format!("{host}:{port}");
    match addr.to_socket_addrs() {
        Ok(iter) => iter.map(|sa| sa.ip()).collect(),
        Err(_) => vec![],
    }
}

fn parse_openvpn_remotes(config_text: &str) -> Vec<(String, u16, String)> {
    let mut proto = "udp".to_string();

    for line in config_text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with(';') {
            continue;
        }
        if l.starts_with("proto ") {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() >= 2 {
                proto = parts[1].to_lowercase();
            }
        }
    }

    let mut remotes = vec![];
    for line in config_text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with(';') {
            continue;
        }
        if l.starts_with("remote ") {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() >= 2 {
                let host = parts[1].to_string();
                let port = if parts.len() >= 3 {
                    parts[2].parse().unwrap_or(1194)
                } else {
                    1194
                };
                remotes.push((host, port, proto.clone()));
            }
        }
    }

    remotes
}

fn nft_delete_table_strict() -> Result<(), String> {
    let out = Command::new("nft")
        .args(["delete", "table", "inet", "stellarkillswitch"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("Failed to start nft: {e}"))?;

    if out.status.success() {
        return Ok(());
    }

    let err = String::from_utf8_lossy(&out.stderr).to_string();
    // If table doesn't exist, treat as success
    if err.contains("No such file") || err.contains("does not exist") {
        return Ok(());
    }

    Err(format!(
        "Failed to delete kill switch table (exit={}):\n{}",
        out.status.code().unwrap_or(-1),
        err
    ))
}

fn run_nft_script(script: &str) -> Result<(), String> {
    let mut child = Command::new("nft")
        .arg("-f")
        .arg("-")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start nft: {e}"))?;

    {
        let stdin = child.stdin.as_mut().ok_or("Failed to open nft stdin")?;
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Failed writing nft script: {e}"))?;
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("Failed waiting for nft: {e}"))?;

    if out.status.success() {
        Ok(())
    } else {
        Err(format!(
            "nft failed (exit={}):\n{}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr)
        ))
    }
}

fn is_ip_literal(host: &str) -> bool {
    host.parse::<std::net::IpAddr>().is_ok()
}

fn build_script(remotes: Vec<(String, u16, String)>) -> Result<String, String> {
    let mut s = String::new();

    // Build fresh table every time (we delete before applying).
    s.push_str("add table inet stellarkillswitch\n");
    s.push_str("add chain inet stellarkillswitch output { type filter hook output priority 0; policy accept; }\n");
    s.push_str("flush chain inet stellarkillswitch output\n");

    // Allow loopback + established
    s.push_str("add rule inet stellarkillswitch output oifname \"lo\" accept\n");
    s.push_str("add rule inet stellarkillswitch output ct state established,related accept\n");

    // Allow tunnel interfaces
    s.push_str("add rule inet stellarkillswitch output oifname { \"tun\", \"tun0\", \"tun1\", \"tun2\", \"tun3\", \"tun4\", \"tun5\", \"tun6\", \"tun7\", \"tun8\", \"tun9\", \"tap0\", \"tap1\", \"tap2\", \"tap3\", \"tap4\", \"tap5\", \"tap6\", \"tap7\", \"tap8\", \"tap9\" } accept\n");

    // DNS (compat). Note: if a system uses DoH/DoT only, DNS might fail; we handle that with fallback below.
    s.push_str("add rule inet stellarkillswitch output udp dport 53 accept\n");
    s.push_str("add rule inet stellarkillswitch output tcp dport 53 accept\n");

    let mut any_allow = false;

    // Allow handshake to configured VPN remotes
    for (host, port, proto) in remotes {
        let tcp = proto.contains("tcp");

        if is_ip_literal(&host) {
            // Host is already an IP literal
            any_allow = true;
            if tcp {
                // We don't know if it's v4/v6 here in string, but nft will parse correct family via ip/ip6:
                // Safer: try parse
                match host.parse::<IpAddr>() {
          Ok(IpAddr::V4(v4)) => s.push_str(&format!("add rule inet stellarkillswitch output ip daddr {v4} tcp dport {port} accept\n")),
          Ok(IpAddr::V6(v6)) => s.push_str(&format!("add rule inet stellarkillswitch output ip6 daddr {v6} tcp dport {port} accept\n")),
          Err(_) => {}
        }
            } else {
                match host.parse::<IpAddr>() {
          Ok(IpAddr::V4(v4)) => s.push_str(&format!("add rule inet stellarkillswitch output ip daddr {v4} udp dport {port} accept\n")),
          Ok(IpAddr::V6(v6)) => s.push_str(&format!("add rule inet stellarkillswitch output ip6 daddr {v6} udp dport {port} accept\n")),
          Err(_) => {}
        }
            }
            continue;
        }

        // Resolve hostname to IPs
        let ips = resolve_host(&host, port);

        if ips.is_empty() {
            // Fallback: allow ONLY the remote port/proto to any destination.
            // This keeps UX working even if DNS is "special" (DoH/DoT etc).
            // Yes, it's less strict, but it's better than bricking the user offline.
            any_allow = true;
            if tcp {
                s.push_str(&format!(
                    "add rule inet stellarkillswitch output tcp dport {port} accept\n"
                ));
            } else {
                s.push_str(&format!(
                    "add rule inet stellarkillswitch output udp dport {port} accept\n"
                ));
            }
            continue;
        }

        for ip in ips {
            any_allow = true;
            match (ip, tcp) {
                (IpAddr::V4(v4), true) => s.push_str(&format!(
          "add rule inet stellarkillswitch output ip daddr {v4} tcp dport {port} accept\n"
        )),
                (IpAddr::V4(v4), false) => s.push_str(&format!(
          "add rule inet stellarkillswitch output ip daddr {v4} udp dport {port} accept\n"
        )),
                (IpAddr::V6(v6), true) => s.push_str(&format!(
          "add rule inet stellarkillswitch output ip6 daddr {v6} tcp dport {port} accept\n"
        )),
                (IpAddr::V6(v6), false) => s.push_str(&format!(
          "add rule inet stellarkillswitch output ip6 daddr {v6} udp dport {port} accept\n"
        )),
            }
        }
    }

    if !any_allow {
        return Err("No VPN remotes could be allowed. Invalid config?".to_string());
    }

    // Default drop
    s.push_str("add rule inet stellarkillswitch output drop\n");
    Ok(s)
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 3 {
        die(
            "Usage: stellar-vpn-helper killswitch <enable|disable> [--config /path/to/config.ovpn]",
        );
    }

    if args[1] != "killswitch" {
        die("Unsupported command");
    }

    let action = args[2].as_str();
    let mut config: Option<PathBuf> = None;

    let mut i = 3;
    while i < args.len() {
        match args[i].as_str() {
            "--config" => {
                i += 1;
                let p = args.get(i).cloned().unwrap_or_default();
                if p.trim().is_empty() {
                    die("--config requires a value");
                }
                config = Some(PathBuf::from(p));
            }
            _ => die("Unknown arg"),
        }
        i += 1;
    }

    match action {
        "disable" => {
            if let Err(e) = nft_delete_table_strict() {
                die(&e);
            }
            return;
        }
        "enable" => {
            let cfg = config.unwrap_or_else(|| die("--config is required for enable"));
            if !cfg.exists() {
                die("Config file not found");
            }

            let cfg_text = fs::read_to_string(&cfg).unwrap_or_default();
            let remotes = parse_openvpn_remotes(&cfg_text);
            if remotes.is_empty() {
                die("No 'remote' entries found in config");
            }

            // Delete old table strictly first, then apply a clean script.
            if let Err(e) = nft_delete_table_strict() {
                die(&e);
            }

            let script = match build_script(remotes) {
                Ok(s) => s,
                Err(e) => die(&e),
            };

            if let Err(e) = run_nft_script(&script) {
                die(&e);
            }
        }
        _ => die("Invalid action"),
    }
}
