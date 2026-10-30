//! Pure PF rules: literal endpoints and a verified tunnel interface only.
use std::{io, net::IpAddr};
pub const ANCHOR: &str = "com.apple/000.stellar-vpn";
#[derive(Clone)]
pub struct Endpoint { pub ip: IpAddr, pub port: u16, pub tcp: bool }
pub fn rules(endpoints: &[Endpoint], interface: Option<&str>) -> io::Result<String> {
    if endpoints.is_empty() || endpoints.len() > 32 || endpoints.iter().any(|e| e.port == 0 || e.ip.is_unspecified() || e.ip.is_multicast() || e.ip.is_loopback()) { return Err(io::Error::other("Invalid firewall endpoints")); }
    let mut result = String::from("pass out quick on lo0 all no state\n");
    if let Some(name) = interface {
        if !name.strip_prefix("utun").is_some_and(|n| !n.is_empty() && n.len() <= 5 && n.bytes().all(|c| c.is_ascii_digit())) { return Err(io::Error::other("Invalid tunnel interface")); }
        result.push_str(&format!("pass out quick on {name} all no state\n"));
    }
    for e in endpoints {
        let family = if e.ip.is_ipv4() { "inet" } else { "inet6" };
        let proto = if e.tcp { "tcp" } else { "udp" };
        result.push_str(&format!("pass out quick {family} proto {proto} from any to {} port {} no state\n", e.ip, e.port));
    }
    result.push_str("block drop out quick all\n"); Ok(result)
}
pub fn compatible_root_rules(input: &str) -> bool {
    // pfctl -sr also emits Apple's normalization anchor. It cannot pass traffic
    // around our filter anchor, and must not be mistaken for a custom pass rule.
    input.lines().map(str::trim).filter(|line| !line.is_empty()
        && *line != "scrub-anchor \"com.apple/*\" all fragment reassemble"
        && *line != "scrub-anchor \"com.apple/*\" all")
        .collect::<Vec<_>>() == ["anchor \"com.apple/*\" all"]
}
#[cfg(test)]
mod tests {
    use super::*;
    fn endpoints() -> Vec<Endpoint> { vec![Endpoint { ip: "203.0.113.10".parse().unwrap(), port: 1197, tcp: false }] }
    #[test] fn ipv4_ipv6_and_dns_outside_the_tunnel_are_blocked() {
        let value = rules(&endpoints(), Some("utun12")).unwrap();
        assert!(value.contains("pass out quick on utun12 all no state"));
        assert!(value.contains("inet proto udp from any to 203.0.113.10 port 1197 no state"));
        assert!(value.ends_with("block drop out quick all\n")); assert!(!value.contains("port 53")); assert!(!value.contains("keep state"));
    }
    #[test] fn missing_tunnel_only_allows_loopback_and_vpn_endpoint() { let value = rules(&endpoints(), None).unwrap(); assert!(!value.contains("utun")); assert_eq!(value.lines().count(), 3); }
    #[test] fn injection_and_invalid_endpoints_are_rejected() {
        for name in ["utun1\npass out all", "en0", "utun", "utun-1"] { assert!(rules(&endpoints(), Some(name)).is_err()); }
        for ip in ["0.0.0.0", "::", "127.0.0.1", "224.0.0.1"] { assert!(rules(&[Endpoint { ip: ip.parse().unwrap(), port: 1197, tcp: false }], None).is_err()); }
        assert!(rules(&[], None).is_err());
    }
    #[test] fn custom_rules_cannot_be_overwritten() { assert!(compatible_root_rules("anchor \"com.apple/*\" all\n")); assert!(!compatible_root_rules("pass out quick all\nanchor \"com.apple/*\" all")); assert!(!compatible_root_rules("")); }
    #[test] fn apple_normalization_anchor_is_not_a_custom_filter_rule() {
        assert!(compatible_root_rules("scrub-anchor \"com.apple/*\" all fragment reassemble\nanchor \"com.apple/*\" all\n"));
        assert!(!compatible_root_rules("scrub-anchor \"other/*\" all\nanchor \"com.apple/*\" all\n"));
    }
}
