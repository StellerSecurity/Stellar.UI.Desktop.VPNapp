#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
mod macos_client;
mod firewall;
#[cfg(target_os = "macos")]
mod macos_firewall;
#[cfg(target_os = "macos")]
mod macos_probe;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
mod linux_firewall;
fn main() {
    #[cfg(target_os = "macos")]
    if macos::run().is_err() { eprintln!("Stellar VPN helper stopped."); std::process::exit(1); }
    #[cfg(target_os = "linux")]
    if linux::run().is_err() { eprintln!("Stellar VPN helper stopped."); std::process::exit(1); }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    { eprintln!("This helper target is unsupported."); std::process::exit(1); }
}
