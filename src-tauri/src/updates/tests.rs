use super::trust::*;
use minisign_verify::PublicKey;
#[test] fn native_install_never_disconnects_or_unblocks_to_make_an_update_work() {
    use stellar_core::domain::{ConnectionSnapshot, ConnectionStatus};
    assert!(installation_allowed(&ConnectionSnapshot::default()));
    assert!(!installation_allowed(&ConnectionSnapshot { status: ConnectionStatus::Connected, ..Default::default() }));
    assert!(!installation_allowed(&ConnectionSnapshot { traffic_blocked: true, ..Default::default() }));
}
// Public fixtures produced with Node's independent Ed25519/Blake2b primitives
// and the published RFC8032 test seed. No real signing key is used or stored.
const KEY: &str = "RWQBAgMEBQYHCNdamAGCsQq31Uv+08lkBzoO4XLz2qYjJa8CGmj3B1Ea";
const DATA: &[u8] = b"Stellar OTA public test vector\n";
const SIG: &str = "untrusted comment: public RFC8032 test fixture only\nRUQBAgMEBQYHCDY7YleM/BoaJQETcaoz7/LSaXi+pr0BiObnu6ILp/M7SN3ZLziwGMqsQPpswsQySr4gmGtg3MkpTIwEiGtViQA=\ntrusted comment: timestamp:1\tfile:test.app.tar.gz\tversion:1.2.3\nV7C6JW+U3OfHf71UzxmBjILdO21Bu5nT8nEhEzSlcueCLhfYGzic+RdOP/Al76ppGP40PPmYWocAdQsTieTsAw==";
const UNVERSIONED: &str = "untrusted comment: public RFC8032 test fixture only\nRUQBAgMEBQYHCDY7YleM/BoaJQETcaoz7/LSaXi+pr0BiObnu6ILp/M7SN3ZLziwGMqsQPpswsQySr4gmGtg3MkpTIwEiGtViQA=\ntrusted comment: timestamp:1\tfile:test.app.tar.gz\nFtsu0CYdLimTWPZ4lrEw9Vh+jtf7ghvmz4v+SHwCUK53AXufHCtOwx1YCKazqbXIMmmqOFn5ScqnSJ2E3Sa3Aw==";
const DUPLICATE: &str = "untrusted comment: public RFC8032 test fixture only\nRUQBAgMEBQYHCDY7YleM/BoaJQETcaoz7/LSaXi+pr0BiObnu6ILp/M7SN3ZLziwGMqsQPpswsQySr4gmGtg3MkpTIwEiGtViQA=\ntrusted comment: version:1.2.3\tversion:1.2.3\nscrYAHJkfb8df3dBF1tmzdv2vkzwoFX/XGAzHiq0SzNpDCzKxE5JbfCZXZBRwCovJ/FkTiLkECw0ZVd1vY37Aw==";
fn candidate() -> Candidate { Candidate { version: "1.2.3".into(), notes: String::new(), url: "https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/Stellar%20VPN.app.tar.gz".into(), signature: SIG.into() } }
#[test] fn completion_notice_requires_the_actual_running_version_not_just_a_marker() {
    assert!(completed_version("1.2.3", "1.2.3"));
    assert!(!completed_version("1.2.3", "1.0.0"));
    assert!(!completed_version("1.2.3", "9.9.9"));
    assert!(!completed_version("bad", "bad"));
}
#[test] fn pinned_key_matches_the_legacy_public_key_and_is_not_the_test_key() {
    assert!(public_key().is_ok());
    assert_ne!(PUBLIC_KEY, KEY);
    assert!(verify(DATA, &candidate(), &public_key().unwrap()).is_err());
}
#[test] fn genuine_signature_and_authenticated_version_are_accepted() {
    verify(DATA, &candidate(), &PublicKey::from_base64(KEY).unwrap()).unwrap();
}
#[test] fn production_streaming_verification_checks_all_chunks_and_the_global_signature() {
    let key = PublicKey::from_base64(KEY).unwrap();
    let sig = signature(SIG).unwrap();
    let mut stream = key.verify_stream(&sig).unwrap();
    for chunk in DATA.chunks(3) { stream.update(chunk); }
    stream.finalize().unwrap(); signed_version(&sig, "1.2.3").unwrap();
    let mut altered = key.verify_stream(&sig).unwrap();
    altered.update(b"attacker content"); assert!(altered.finalize().is_err());
    let legacy = SIG.replacen("RUQB", "RWQB", 1);
    let legacy = signature(&legacy).unwrap();
    assert!(key.verify_stream(&legacy).is_err());
}
#[test] fn changed_payload_wrong_key_and_modified_trusted_comment_are_rejected() {
    let key = PublicKey::from_base64(KEY).unwrap();
    assert!(verify(b"attacker content", &candidate(), &key).is_err());
    let mut c = candidate(); c.signature = SIG.replace("version:1.2.3", "version:9.9.9"); c.version = "9.9.9".into();
    assert!(verify(DATA, &c, &key).is_err());
    let mut c = candidate(); c.signature = SIG.replace("V7C6JW", "W7C6JW");
    assert!(verify(DATA, &c, &key).is_err());
}
#[test] fn inflated_manifest_version_cannot_replay_a_genuine_older_artifact() {
    let mut c = candidate(); c.version = "9.9.9".into();
    assert!(verify(DATA, &c, &PublicKey::from_base64(KEY).unwrap()).is_err());
}
#[test] fn valid_but_unversioned_and_ambiguous_signatures_are_rejected() {
    let key = PublicKey::from_base64(KEY).unwrap();
    for value in [UNVERSIONED, DUPLICATE] {
        key.verify(DATA, &signature(value).unwrap(), false).unwrap();
        let mut c = candidate(); c.signature = value.into();
        assert!(verify(DATA, &c, &key).is_err());
    }
}
#[test] fn base64_wrapped_tauri_signatures_are_supported_and_malformed_input_fails() {
    let encoded = "dW50cnVzdGVkIGNvbW1lbnQ6IHB1YmxpYyBSRkM4MDMyIHRlc3QgZml4dHVyZSBvbmx5ClJVUUJBZ01FQlFZSENEWTdZbGVNL0JvYUpRRVRjYW96Ny9MU2FYaStwcjBCaU9ibnU2SUxwL003U04zWkx6aXdHTXFzUVBwc3dzUXlTcjRnbUd0ZzNNa3BUSXdFaUd0VmlRQT0KdHJ1c3RlZCBjb21tZW50OiB0aW1lc3RhbXA6MQlmaWxlOnRlc3QuYXBwLnRhci5negl2ZXJzaW9uOjEuMi4zClY3QzZKVytVM09mSGY3MVV6eG1CaklMZE8yMUJ1NW5UOG5FaEV6U2xjdWVDTGhmWUd6aWMrUmRPUC9BbDc2cHBHUDQwUFBtWVdvY0FkUXNUaWVUc0F3PT0=";
    assert_eq!(decode_base64(encoded).unwrap(), SIG.as_bytes());
    let mut c = candidate(); c.signature = encoded.into();
    verify(DATA, &c, &PublicKey::from_base64(KEY).unwrap()).unwrap();
    for invalid in ["A", "====", "AA=A", "A===", "AB==", "AAA!", "AA\nA", "AAAA=", ""] { assert!(decode_base64(invalid).is_err(), "{invalid}"); }
    assert!(signature(&format!("{SIG}\nextra")).is_err());
    assert!(signature(&"x".repeat(MAX_SIGNATURE + 1)).is_err());
}
#[test] fn stable_versions_are_strict_and_ordered_without_aliases() {
    assert!(Version::parse("1.10.0").unwrap() > Version::parse("1.9.99").unwrap());
    for invalid in ["v1.2.3", "01.2.3", "1.2", "1.2.3.4", "1.2.3-beta", "1.2.3+build", "1.-2.3", "1. 2.3", "4294967296.0.0"] { assert!(Version::parse(invalid).is_err()); }
}
#[test] fn artifact_origin_channel_and_version_cannot_be_changed_by_the_server() {
    assert!(artifact_url(&candidate().url, "1.2.3"));
    for url in ["http://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/a.app.tar.gz", "https://evil.test/a.app.tar.gz", "https://desktopreleasesassetsprod.stellarsecurity.com.evil.test/vpn/desktop-v2/1.2.3/a.app.tar.gz", "https://user@desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/a.app.tar.gz", "https://desktopreleasesassetsprod.stellarsecurity.com/vpn/0.2.0/a.app.tar.gz", "https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/%2e%2e/a.app.tar.gz", "https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/a.app.tar.gz?key=override"] { assert!(!artifact_url(url, "1.2.3"), "{url}"); }
}
#[test] fn manifest_preserves_plain_notes_and_rejects_old_or_malformed_releases() {
    let json = r#"{"version":"1.2.3","notes":"<script>not HTML</script>","platforms":{"darwin-aarch64":{"url":"https://desktopreleasesassetsprod.stellarsecurity.com/vpn/desktop-v2/1.2.3/a.app.tar.gz","signature":"not-yet-verified"}}}"#;
    assert_eq!(manifest(json.as_bytes(), "1.0.0", "darwin-aarch64").unwrap().unwrap().notes, "<script>not HTML</script>");
    assert!(manifest(json.as_bytes(), "1.2.3", "darwin-aarch64").unwrap().is_none());
    assert!(manifest(json.as_bytes(), "2.0.0", "darwin-aarch64").unwrap().is_none());
    assert!(manifest(json.as_bytes(), "1.0.0", "darwin-x86_64").is_err());
    assert!(manifest(json.replace("\"notes\":", "\"pubkey\":").as_bytes(), "1.0.0", "darwin-aarch64").is_err());
    assert!(manifest(&vec![b' '; MAX_MANIFEST + 1], "1.0.0", "darwin-aarch64").is_err());
}
#[test] fn archive_traversal_links_and_wrong_products_are_refused() {
    archive_paths("Stellar VPN.app/\nStellar VPN.app/Contents/a\n", "drwx\n-rwx\n").unwrap();
    archive_paths("Stellar VPN.app\nStellar VPN.app/Contents/a\n", "drwx\n-rwx\n").unwrap();
    for name in ["/tmp/a", "../a", "Stellar VPN.app/../a", "Other.app/a", "Stellar VPN.app/a\\b"] { assert!(archive_paths(name, "-rwx").is_err()); }
    assert!(archive_paths("Stellar VPN.app/link", "lrwx").is_err());
    assert!(archive_paths("Stellar VPN.app/link", "hrwx").is_err());
    assert!(archive_paths("Stellar VPN.app/a\nStellar VPN.app/b", "-rwx").is_err());
}
