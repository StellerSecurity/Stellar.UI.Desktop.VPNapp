#[cfg(target_os = "macos")]
mod macos;
mod firewall;
#[cfg(target_os = "macos")]
mod macos_firewall;
#[cfg(target_os = "macos")]
mod macos_probe;
fn main() {
    #[cfg(target_os = "macos")]
    if macos::run().is_err() { eprintln!("Stellar VPN helper stopped."); std::process::exit(1); }
    #[cfg(not(target_os = "macos"))]
    { eprintln!("This helper target is macOS only."); std::process::exit(1); }
}
