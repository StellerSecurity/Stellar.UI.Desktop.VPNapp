//! Bounded, non-secret service replies shared by native clients.
use crate::domain::{AppError, ConnectionSnapshot, ConnectionStatus};
pub fn decode(bytes: &[u8]) -> Result<(ConnectionSnapshot, u64, u64), AppError> {
    let fail = || AppError::new("vpn_helper_unavailable", "The Stellar VPN system helper is unavailable.");
    if bytes.is_empty() || bytes.len() > 256 || !bytes.ends_with(b"\n") || bytes[..bytes.len()-1].contains(&b'\n') { return Err(fail()); }
    let line = std::str::from_utf8(bytes).map_err(|_| fail())?.trim_end_matches('\n');
    match line {
        "DISCONNECTED" => return Ok((ConnectionSnapshot::default(), 0, 0)),
        "BLOCKED" => return Ok((ConnectionSnapshot { traffic_blocked: true, ..ConnectionSnapshot::default() }, 0, 0)),
        "ERROR timeout" => return Err(AppError::new("vpn_timeout", "Connection timed out after 30 seconds. Please try again.")), _ => {}
    }
    let fields: Vec<_> = line.split(' ').collect();
    if fields.len() != 5 || fields[0] != "CONNECTED" || fields[1].is_empty() || fields[1].len() > 64
        || !fields[1].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') { return Err(fail()); }
    let connected_at = fields[2].parse::<u64>().map_err(|_| fail())?;
    let received = fields[3].parse().map_err(|_| fail())?; let sent = fields[4].parse().map_err(|_| fail())?;
    Ok((ConnectionSnapshot { status: ConnectionStatus::Connected, server_id: Some(fields[1].into()), connected_at: Some(connected_at), ..ConnectionSnapshot::default() }, received, sent))
}
pub fn capabilities(bytes: &[u8]) -> Option<bool> {
    match bytes { b"CAPABILITIES 3\n" => Some(false), b"CAPABILITIES 3 kill-switch live-kill-switch\n" => Some(true), _ => None }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn replies_never_invent_a_connected_state() {
        assert_eq!(decode(b"CONNECTED ch-1 42 123 456\n").unwrap().0.server_id.as_deref(), Some("ch-1"));
        assert!(decode(b"BLOCKED\n").unwrap().0.traffic_blocked);
        assert_eq!(decode(b"DISCONNECTED\n").unwrap().0.status, ConnectionStatus::Disconnected);
        for value in [b"CONNECTED ch-1 42 123 456".as_slice(), b"CONNECTED ../bad 42 1 2\n", b"CONNECTED ch-1 1 -2 3\n", b"CONNECTED ch-1 1 2 3\nDISCONNECTED\n", b"CONNECTED ch-1 1 2 3 extra\n"] { assert!(decode(value).is_err()); }
        assert!(decode(&vec![b'x'; 257]).is_err());
    }
    #[test] fn unsupported_helper_cannot_claim_firewall_verification() {
        assert_eq!(capabilities(b"CAPABILITIES 3\n"), Some(false));
        assert_eq!(capabilities(b"CAPABILITIES 3 kill-switch live-kill-switch\n"), Some(true));
        assert_eq!(capabilities(b"CAPABILITIES 2 kill-switch\n"), None);
        assert_eq!(capabilities(b"CAPABILITIES 3 kill-switch live-kill-switch extra\n"), None);
    }
}
