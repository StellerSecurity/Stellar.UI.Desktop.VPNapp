use std::{
    env,
    fs,
    io::Write,
    net::{IpAddr, ToSocketAddrs},
    path::PathBuf,
    process::{Command, Stdio},
};

fn die(msg: &str) -> ! {
    eprintln!("{msg}");
    std::process::exit(1);
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
        Err(format!("nft failed: {}", String::from_utf8_lossy(&out.stderr)))
    }
}

fn parse_openvpn_remotes(config_text: &str) -> Vec<(String, u16, String)> {
    let mut default_proto = "udp".to_string();

    for line in config_text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') || l.starts_with(';') {
            continue;
        }
        if l.starts_with("proto ") {
            let parts: Vec<&str> = l.split_whitespace().collect();
            if parts.len() >= 2 {
                default_proto = parts[1].to_lowercase();
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

                // OpenVPN supports: remote host [port] [proto]
                let proto = if parts.len() >= 4 {
                    parts[3].to_lowercase()
                } else {
                    default_proto.clone()
                };

                remotes.push((host, port, proto));
            }
        }
    }

    remotes
}

fn resolve_host(host: &str, port: u16) -> Vec<IpAddr> {
    let addr = format!("{host}:{port}");
    match addr.to_socket_addrs() {
        Ok(iter) => iter.map(|sa| sa.ip()).collect(),
        Err(_) => vec![],
    }
}

fn build_killswitch_script(remotes: Vec<(String, u16, String)>) -> String {
    let mut s = String::new();

    // Create fresh table/chain and then final drop.
    // Chain policy accept reduces “brick risk” during partial apply.
    s.push_str("add table inet stellarkillswitch\n");
    s.push_str("add chain inet stellarkillswitch output { type filter hook output priority 0; policy accept; }\n");
    s.push_str("flush chain inet stellarkillswitch output\n");

    s.push_str("add rule inet stellarkillswitch output oifname \"lo\" accept\n");
    s.push_str("add rule inet stellarkillswitch output ct state established,related accept\n");

    // Allow VPN tunnel interfaces (quoted)
    s.push_str("add rule inet stellarkillswitch output oifname { \"tun0\", \"tun1\", \"tun2\", \"tun3\", \"tun4\", \"tun5\", \"tun6\", \"tun7\", \"tun8\", \"tun9\" } accept\n");

    // DNS allow (compat mode)
    s.push_str("add rule inet stellarkillswitch output udp dport 53 accept\n");
    s.push_str("add rule inet stellarkillswitch output tcp dport 53 accept\n");

    // Allow handshake to configured VPN remotes
    for (host, port, proto) in remotes {
        let ips = resolve_host(&host, port);
        for ip in ips {
            match (ip, proto.contains("tcp")) {
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

    s.push_str("add rule inet stellarkillswitch output drop\n");
    s
}

fn main() {
    // English-only comments per your rules.
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        die("Usage: stellar-vpn-helper killswitch <enable|disable> [--config /path/to/config.ovpn]");
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
            // Best-effort remove.
            let _ = Command::new("nft")
                .args(["delete", "table", "inet", "stellarkillswitch"])
                .output();
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

            // IMPORTANT: delete outside script so missing table does not abort script parsing
            let _ = Command::new("nft")
                .args(["delete", "table", "inet", "stellarkillswitch"])
                .output();

            let script = build_killswitch_script(remotes);
            if let Err(e) = run_nft_script(&script) {
                die(&e);
            }
        }
        _ => die("Invalid action"),
    }
}
