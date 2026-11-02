//! Portable tests of the actual Windows engine. The OS transport alone is fake;
//! no service, firewall, credential vault or external VPN endpoint is touched.
use std::{collections::VecDeque, sync::Mutex};
use stellar_core::{domain::{AppError, ConnectionStatus}, ports::VpnEngine, openvpn::{ValidatedConfig, VpnCredentials}};
static TEST: Mutex<()> = Mutex::new(());
static RESPONSES: Mutex<VecDeque<(&'static str, Result<Vec<u8>, AppError>)>> = Mutex::new(VecDeque::new());
mod windows {
    pub fn exchange(request: Vec<u8>, _: u32) -> Result<Vec<u8>, stellar_core::domain::AppError> {
        let (expected, response) = super::RESPONSES.lock().unwrap().pop_front().expect("unexpected OS call");
        assert!(request.starts_with(expected.as_bytes()), "unexpected protocol command"); response
    }
}
mod vpn { pub fn known_server(value: &str) -> bool { value == "ch-1" } }
mod engine { include!("windows_vpn.rs"); }
fn reply(command: &'static str, value: &'static str) { RESPONSES.lock().unwrap().push_back((command, Ok(value.as_bytes().to_vec()))); }
fn unavailable(command: &'static str) { RESPONSES.lock().unwrap().push_back((command, Err(AppError::new("test_unavailable", "synthetic transport failure")))); }
fn prepared() -> engine::OpenVpnEngine {
    let mut value = engine::OpenVpnEngine::default();
    value.set_credentials(VpnCredentials::new("stvpn_0123456789abcdef".into(), "a".repeat(32)).unwrap()).unwrap();
    let config = "client\ndev tun\nproto udp\nremote 192.0.2.10 1194\nremote-cert-tls server\nauth-user-pass\n<ca>\nTEST\n</ca>\n<cert>\nTEST\n</cert>\n<key>\nTEST\n</key>\n";
    value.prepare("ch-1", ValidatedConfig::parse(config).unwrap()).unwrap(); value.set_session_expiry(u64::MAX); value
}
#[test] fn idle_kill_preference_never_arms_a_firewall_or_claims_blocking() {
    let _test = TEST.lock().unwrap(); RESPONSES.lock().unwrap().clear(); let mut engine = prepared();
    reply("CAPABILITIES", "CAPABILITIES 3 kill-switch live-kill-switch\n"); engine.set_kill_switch(true).unwrap();
    assert!(engine.poll().unwrap().is_none()); assert!(RESPONSES.lock().unwrap().is_empty());
}
#[test] fn established_tunnel_supports_live_kill_changes_and_expiry_keeps_blocking() {
    let _test = TEST.lock().unwrap(); RESPONSES.lock().unwrap().clear(); let mut engine = prepared();
    reply("CONNECT", "CONNECTED ch-1 42 100 50\n"); assert_eq!(engine.connect("ch-1").unwrap().status, ConnectionStatus::Connected);
    reply("CAPABILITIES", "CAPABILITIES 3 kill-switch live-kill-switch\n"); reply("PROTECT 1", "PROTECTED 1\n"); engine.set_kill_switch(true).unwrap();
    reply("EXPIRE", "BLOCKED\n"); assert!(engine.expire().unwrap().traffic_blocked);
    reply("STATUS", "BLOCKED\n"); assert!(engine.poll().unwrap().unwrap().traffic_blocked);
    reply("DISCONNECT", "DISCONNECTED\n"); assert!(!engine.disconnect().unwrap().traffic_blocked);
    assert!(engine.poll().unwrap().is_none()); assert!(RESPONSES.lock().unwrap().is_empty());
}
#[test] fn timeout_reads_actual_helper_state_and_transport_loss_cannot_leave_a_green_snapshot() {
    let _test = TEST.lock().unwrap(); RESPONSES.lock().unwrap().clear(); let mut engine = prepared();
    reply("CAPABILITIES", "CAPABILITIES 3 kill-switch live-kill-switch\n"); engine.set_kill_switch(true).unwrap();
    reply("CONNECT", "ERROR timeout\n"); reply("STATUS", "BLOCKED\n"); assert!(engine.connect("ch-1").is_err());
    unavailable("STATUS"); let lost = engine.poll().unwrap().unwrap();
    assert_eq!(lost.status, ConnectionStatus::Disconnected); assert!(!lost.traffic_blocked);
    reply("PROTECT 0", "PROTECTED 0\n"); engine.set_kill_switch(false).unwrap();
    assert!(engine.poll().unwrap().is_none()); assert!(RESPONSES.lock().unwrap().is_empty());
}
#[test] fn missing_helper_does_not_prevent_logout_when_no_tunnel_was_owned() {
    let _test = TEST.lock().unwrap(); RESPONSES.lock().unwrap().clear(); let mut engine = prepared();
    unavailable("DISCONNECT"); assert_eq!(engine.disconnect().unwrap().status, ConnectionStatus::Disconnected);
}
