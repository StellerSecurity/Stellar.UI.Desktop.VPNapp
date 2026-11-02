//! Restricted OpenVPN input boundary. No file, process or network IO in this module.
use crate::domain::AppError;
use std::fmt;
pub const CONNECTION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
pub fn connection_attempt_expired(elapsed: std::time::Duration) -> bool { elapsed >= CONNECTION_TIMEOUT }

pub struct VpnCredentials { username: Vec<u8>, password: Vec<u8> }
impl VpnCredentials {
    pub fn new(username: String, password: String) -> Result<Self, AppError> {
        let value = Self { username: username.into_bytes(), password: password.into_bytes() };
        if value.username.len() != 22 || !value.username.starts_with(b"stvpn_")
            || !value.username[6..].iter().all(u8::is_ascii_hexdigit)
            || value.password.len() != 32 || !value.password.iter().all(u8::is_ascii_hexdigit) {
            return Err(AppError::new("invalid_vpn_auth", "VPN authentication is unavailable. Please log in again."));
        }
        Ok(value)
    }
    /// Only for the private OpenVPN management channel; never an event or a snapshot.
    pub fn write_management_auth(&self, mut writer: impl std::io::Write) -> std::io::Result<()> {
        writer.write_all(b"username \"Auth\" \"")?;
        writer.write_all(&self.username)?;
        writer.write_all(b"\"\npassword \"Auth\" \"")?;
        writer.write_all(&self.password)?;
        writer.write_all(b"\"\n")
    }
    pub fn write_helper_connect(&self, server_id: &str, expires_at: u64, config: &ValidatedConfig, mut writer: impl std::io::Write) -> std::io::Result<()> {
        self.write_helper_connect_protected(server_id, expires_at, config, false, &mut writer)
    }
    pub fn write_helper_connect_protected(&self, server_id: &str, expires_at: u64, config: &ValidatedConfig, protected: bool, mut writer: impl std::io::Write) -> std::io::Result<()> {
        self.write_helper_request(server_id, expires_at, config, protected, None, &mut writer)
    }
    pub fn write_helper_connect_budget(&self, server_id: &str, expires_at: u64, config: &ValidatedConfig, protected: bool, timeout: std::time::Duration, mut writer: impl std::io::Write) -> std::io::Result<()> {
        let milliseconds = timeout.as_millis();
        if milliseconds == 0 || milliseconds > 30_000 { return Err(std::io::Error::other("Invalid connection timeout")); }
        self.write_helper_request(server_id, expires_at, config, protected, Some(milliseconds), &mut writer)
    }
    fn write_helper_request(&self, server_id: &str, expires_at: u64, config: &ValidatedConfig, protected: bool, timeout_ms: Option<u128>, mut writer: impl std::io::Write) -> std::io::Result<()> {
        if server_id.is_empty() || server_id.len() > 64 || !server_id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
            return Err(std::io::Error::other("Invalid VPN location"));
        }
        write!(writer, "CONNECT {server_id} ")?;
        writer.write_all(&self.username)?; writer.write_all(b" ")?;
        writer.write_all(&self.password)?;
        if let Some(timeout) = timeout_ms { writeln!(writer, " {expires_at} {} {} {timeout}", config.as_str().len(), u8::from(protected))?; }
        else if protected { writeln!(writer, " {expires_at} {} 1", config.as_str().len())?; }
        else { writeln!(writer, " {expires_at} {}", config.as_str().len())?; }
        writer.write_all(config.as_str().as_bytes())
    }
}
impl fmt::Debug for VpnCredentials {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("VpnCredentials([redacted])") }
}
impl Drop for VpnCredentials {
    fn drop(&mut self) {
        for byte in self.username.iter_mut().chain(self.password.iter_mut()) {
            // Volatile stores prevent the compiler removing these final writes.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

pub struct ValidatedConfig(String);
impl Drop for ValidatedConfig {
    fn drop(&mut self) {
        // Inline configurations contain a private client key.
        for byte in unsafe { self.0.as_bytes_mut() } {
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}
impl fmt::Debug for ValidatedConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str("ValidatedConfig([redacted])") }
}
impl ValidatedConfig {
    pub fn parse(input: &str) -> Result<Self, AppError> {
        let fail = || AppError::new("unsafe_vpn_config", "This VPN configuration is unsupported.");
        if input.is_empty() || input.len() > 131072 || !input.is_ascii()
            || input.bytes().any(|b| b < 32 && ![b'\n', b'\r', b'\t'].contains(&b)) { return Err(fail()); }
        let mut out = String::new();
        let mut block: Option<&str> = None;
        let mut blocks = Vec::new();
        let mut seen = std::collections::HashSet::new();
        let mut remotes = 0;
        for raw in input.lines() {
            let line = raw.trim();
            if let Some(tag) = block {
                if line == format!("</{tag}>") { block = None; }
                // OpenVPN exports may include OpenSSL's certificate text dump and
                // static-key comments. These remain opaque inline data, never options.
                // Reject every nested/alternative tag so data cannot escape its block.
                else if line.contains(['<', '>']) { return Err(fail()); }
                out.push_str(line); out.push('\n'); continue;
            }
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') { continue; }
            if line.starts_with('<') {
                let tag = match line { "<ca>" => "ca", "<cert>" => "cert", "<key>" => "key", "<tls-auth>" => "tls-auth", "<tls-crypt>" => "tls-crypt", _ => return Err(fail()) };
                if blocks.contains(&tag) { return Err(fail()); }
                blocks.push(tag); block = Some(tag); out.push_str(line); out.push('\n'); continue;
            }
            let args: Vec<_> = line.split_whitespace().collect();
            let directive = args[0];
            if directive != "remote" && !seen.insert(directive) { return Err(fail()); }
            let valid = match args.as_slice() {
                ["client"] | ["nobind"] | ["persist-key"] | ["persist-tun"] | ["auth-user-pass"] | ["block-ipv6"] => true,
                ["auth-nocache"] | ["script-security", "1"] | ["allow-compression", "no"] | ["auth-retry", "none"] => true,
                ["dev", "tun"] | ["remote-cert-tls", "server"] | ["auth", "SHA256"] | ["cipher", "AES-256-GCM"]
                    | ["key-direction", "1"] => true,
                ["proto", "udp" | "udp4" | "tcp-client" | "tcp4-client"] => true,
                ["resolv-retry", "infinite"] => true,
                ["hand-window", seconds] => seconds.parse::<u32>().is_ok_and(|n| (1..=120).contains(&n)),
                ["verb", "0" | "1" | "2" | "3"] => true,
                ["remote", host, port] => {
                    remotes += 1;
                    remotes <= 16 && !host.is_empty() && host.len() <= 253
                        && host.bytes().all(|b| b.is_ascii_alphanumeric() || b".-".contains(&b))
                        && !host.starts_with('-') && !host.ends_with('.')
                        && port.parse::<u16>().is_ok_and(|n| n > 0)
                }
                _ => false,
            };
            if !valid { return Err(fail()); }
            out.push_str(&args.join(" ")); out.push('\n');
        }
        if block.is_some() || remotes == 0 || !["client", "dev", "proto", "remote-cert-tls", "auth-user-pass"].iter().all(|x| seen.contains(x))
            || !["ca", "cert", "key"].iter().all(|x| blocks.contains(x))
            || (blocks.contains(&"tls-auth") && (!seen.contains("key-direction") || blocks.contains(&"tls-crypt"))) { return Err(fail()); }
        // Scripts/plugins/config includes/management directives and auth files are never accepted.
        for (directive, safe_line) in [("auth-nocache", "auth-nocache"), ("script-security", "script-security 1"),
            ("allow-compression", "allow-compression no"), ("auth-retry", "auth-retry none")] {
            if !seen.contains(directive) { out.push_str(safe_line); out.push('\n'); }
        }
        Ok(Self(out))
    }
    pub fn as_str(&self) -> &str { &self.0 }
}

#[derive(Debug, PartialEq)]
pub enum ManagementEvent { Connected, Reconnecting, Disconnected, AuthenticationRequested, AuthenticationFailed, Bytes { received: u64, sent: u64 }, Ignored }
pub fn management_event(line: &str) -> ManagementEvent {
    if line.len() > 4096 { return ManagementEvent::Ignored; }
    if line == ">PASSWORD:Need 'Auth' username/password" { return ManagementEvent::AuthenticationRequested; }
    if line.starts_with(">PASSWORD:Verification Failed: 'Auth'") { return ManagementEvent::AuthenticationFailed; }
    if let Some(state) = line.strip_prefix(">STATE:").and_then(|s| s.split(',').nth(1)) {
        return match state { "CONNECTED" if line.split(',').nth(2) == Some("SUCCESS") => ManagementEvent::Connected,
            "RECONNECTING" => ManagementEvent::Reconnecting, "EXITING" => ManagementEvent::Disconnected, _ => ManagementEvent::Ignored };
    }
    if let Some(counts) = line.strip_prefix(">BYTECOUNT:") {
        let values: Vec<_> = counts.split(',').collect();
        if values.len() == 2 { if let (Ok(received), Ok(sent)) = (values[0].parse(), values[1].parse()) { return ManagementEvent::Bytes { received, sent }; } }
    }
    ManagementEvent::Ignored
}

/// OpenVPN byte counters are cumulative; rates use the actual monotonic sample interval.
pub fn traffic_mbps(previous: u64, current: u64, elapsed_seconds: f64) -> Option<f64> {
    if !elapsed_seconds.is_finite() || elapsed_seconds < 0.25 { return None; }
    let delta = current.checked_sub(previous)?;
    Some(delta as f64 * 8.0 / elapsed_seconds / 1_000_000.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn connection_deadline_is_exactly_thirty_seconds() {
        assert!(!connection_attempt_expired(std::time::Duration::from_millis(29_999)));
        assert!(connection_attempt_expired(std::time::Duration::from_secs(30)));
        assert!(connection_attempt_expired(std::time::Duration::from_secs(31)));
    }
    #[test]
    fn traffic_uses_measured_interval_and_rejects_resets() {
        assert_eq!(traffic_mbps(100, 250100, 2.0), Some(1.0));
        assert_eq!(traffic_mbps(100, 100, 2.0), Some(0.0));
        assert_eq!(traffic_mbps(100, 0, 2.0), None);
        assert_eq!(traffic_mbps(0, 100, 0.0), None);
        assert_eq!(traffic_mbps(0, 100, f64::NAN), None);
    }
    fn config() -> String { "client\ndev tun\nproto udp\nremote 203.0.113.10 1197\nremote-cert-tls server\nauth-user-pass\n<ca>\nABC=\n</ca>\n<cert>\nABC=\n</cert>\n<key>\nABC=\n</key>\n".into() }
    #[test]
    fn helper_budget_is_bounded_and_legacy_wire_is_preserved() {
        let auth = VpnCredentials::new("stvpn_0123456789abcdef".into(), "a".repeat(32)).unwrap();
        let config = ValidatedConfig::parse(&config()).unwrap();
        let mut wire = Vec::new();
        auth.write_helper_connect_budget("dk-1", 42, &config, true, std::time::Duration::from_millis(1234), &mut wire).unwrap();
        let text = String::from_utf8(wire).unwrap();
        assert!(text.lines().next().unwrap().ends_with(" 1 1234"));
        for duration in [std::time::Duration::ZERO, std::time::Duration::from_millis(30_001)] {
            let mut output = Vec::new();
            assert!(auth.write_helper_connect_budget("dk-1", 42, &config, false, duration, &mut output).is_err());
            assert!(output.is_empty());
        }
        let mut legacy = Vec::new();
        auth.write_helper_connect("dk-1", 42, &config, &mut legacy).unwrap();
        assert_eq!(String::from_utf8(legacy).unwrap().lines().next().unwrap().split(' ').count(), 6);
    }
    #[test]
    fn only_restricted_configs_are_accepted() {
        let parsed = ValidatedConfig::parse(&config()).unwrap();
        assert!(parsed.as_str().contains("script-security 1\nallow-compression no"));
        // The native adapter validates first, then the privileged helper validates again.
        assert_eq!(ValidatedConfig::parse(parsed.as_str()).unwrap().as_str(), parsed.as_str());
        assert!(ValidatedConfig::parse(&config().replace("<cert>\n", "<cert>\nCertificate:\n    Version: 3 (0x2)\n\n")).is_ok());
        assert!(ValidatedConfig::parse(&config().replace("<key>\n", "<key>\n</key> up /tmp/script\n")).is_err());
        for unsafe_line in ["up /tmp/script", "plugin /tmp/code", "config /tmp/other", "script-security 2", "management 0.0.0.0 7505", "auth-user-pass /tmp/password", "log /tmp/log", "daemon", "pkcs11-providers /tmp/module", "http-proxy localhost 1234", "setenv OPENSSL_CONF /tmp/config", "<connection>", "remote --help 443"] {
            assert!(ValidatedConfig::parse(&(config() + unsafe_line + "\n")).is_err(), "{unsafe_line}");
        }
        assert!(ValidatedConfig::parse(&config().replace("remote-cert-tls server", "")).is_err());
        assert!(ValidatedConfig::parse(&config().replace("</key>", "")).is_err());
    }
    #[test]
    fn vpn_auth_is_not_account_auth_and_cannot_inject_management_commands() {
        let auth = VpnCredentials::new("stvpn_0123456789abcdef".into(), "a".repeat(32)).unwrap();
        assert_eq!(format!("{auth:?}"), "VpnCredentials([redacted])");
        let mut wire = Vec::new(); auth.write_management_auth(&mut wire).unwrap();
        assert_eq!(String::from_utf8(wire).unwrap(), format!("username \"Auth\" \"stvpn_0123456789abcdef\"\npassword \"Auth\" \"{}\"\n", "a".repeat(32)));
        assert!(VpnCredentials::new("email@example.test".into(), "account-password".into()).is_err());
        assert!(VpnCredentials::new("stvpn_0123456789abcdef".into(), "\nkillall\n".into()).is_err());
    }
    #[test]
    fn only_successful_management_state_means_connected() {
        assert_eq!(management_event(">STATE:123,CONNECTED,SUCCESS,10.0.0.2,203.0.113.1"), ManagementEvent::Connected);
        assert_eq!(management_event(">STATE:123,CONNECTED,ERROR"), ManagementEvent::Ignored);
        assert_eq!(management_event("Initialization Sequence Completed"), ManagementEvent::Ignored);
        assert_eq!(management_event(">BYTECOUNT:123,456"), ManagementEvent::Bytes { received: 123, sent: 456 });
        assert_eq!(management_event(">PASSWORD:Need 'Auth' username/password"), ManagementEvent::AuthenticationRequested);
        assert_eq!(management_event(">PASSWORD:Verification Failed: 'Auth'"), ManagementEvent::AuthenticationFailed);
    }
}
