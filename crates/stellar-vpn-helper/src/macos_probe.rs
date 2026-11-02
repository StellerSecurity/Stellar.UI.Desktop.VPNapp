//! Local-only dual-stack PF probe. Its owned utun has no default route, DNS or
//! external peer. Closing its control socket destroys only this test interface.
use std::{ffi::c_void, fs::File, io::{self, Read}, net::{SocketAddr, UdpSocket}, os::fd::{AsRawFd, FromRawFd}, process::{Command, Stdio}, time::{Duration, Instant}};
#[repr(C)] struct ControlInfo { id: u32, name: [u8; 96] }
#[repr(C)] struct ControlAddress { length: u8, family: u8, system: u16, id: u32, unit: u32, reserved: [u32; 5] }
unsafe extern "C" {
    fn socket(domain: i32, kind: i32, protocol: i32) -> i32;
    fn ioctl(fd: i32, request: u64, ...) -> i32;
    fn connect(fd: i32, address: *const ControlAddress, length: u32) -> i32;
    fn getsockopt(fd: i32, level: i32, option: i32, value: *mut c_void, length: *mut u32) -> i32;
    fn fcntl(fd: i32, command: i32, ...) -> i32;
}
pub struct Probe { socket: File, pub name: String, ipv6_route: bool, sequence: u64 }
fn run(program: &str, args: &[&str]) -> io::Result<()> {
    let mut child = Command::new(program).env_clear().args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = child.try_wait()? { return if status.success() { Ok(()) } else { Err(io::Error::other("Local probe setup failed")) }; }
        if Instant::now() >= deadline { let _ = child.kill(); let _ = child.wait(); return Err(io::Error::new(io::ErrorKind::TimedOut, "Local probe command timed out")); }
        std::thread::sleep(Duration::from_millis(10));
    }
}
impl Probe {
    pub fn new() -> io::Result<Self> {
        // Values/layout verified against this machine's Apple SDK headers:
        // PF_SYSTEM=32, SOCK_DGRAM=2, SYSPROTO_CONTROL=2, CTLIOCGINFO=_IOWR(N,3,100).
        let fd = unsafe { socket(32, 2, 2) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        let socket = unsafe { File::from_raw_fd(fd) };
        let mut info = ControlInfo { id: 0, name: [0; 96] };
        let controller = b"com.apple.net.utun_control";
        info.name[..controller.len()].copy_from_slice(controller);
        if unsafe { ioctl(fd, 0xc0644e03, &mut info as *mut ControlInfo) } != 0 { return Err(io::Error::last_os_error()); }
        let address = ControlAddress { length: 32, family: 32, system: 2, id: info.id, unit: 0, reserved: [0; 5] };
        if unsafe { connect(fd, &address, 32) } != 0 { return Err(io::Error::last_os_error()); }
        let mut name = [0u8; 32]; let mut size = name.len() as u32;
        if unsafe { getsockopt(fd, 2, 2, name.as_mut_ptr().cast(), &mut size) } != 0 { return Err(io::Error::last_os_error()); }
        let name = std::str::from_utf8(&name[..name.iter().position(|b| *b == 0).unwrap_or(name.len())]).map_err(|_| io::Error::other("Invalid probe interface"))?.to_owned();
        if !name.strip_prefix("utun").is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit())) { return Err(io::Error::other("Invalid probe interface")); }
        let flags = unsafe { fcntl(fd, 3) };
        if flags < 0 || unsafe { fcntl(fd, 4, flags | 4) } < 0 { return Err(io::Error::last_os_error()); }
        let mut probe = Self { socket, name, ipv6_route: false, sequence: 0 };
        run("/sbin/ifconfig", &[&probe.name, "inet", "198.18.255.254", "198.18.255.253", "up"])?;
        run("/sbin/ifconfig", &[&probe.name, "inet6", "fd73:7465:6c6c:6172::1", "prefixlen", "128", "-dad"])?;
        run("/sbin/route", &["-n", "add", "-inet6", "-host", "fd73:7465:6c6c:6172::2", "-interface", &probe.name])?;
        probe.ipv6_route = true;
        Ok(probe)
    }
    /// Detects an actual outbound packet, not just UDP's successful send result.
    pub fn observed(&mut self, ipv6: bool, port: u16) -> io::Result<bool> {
        let mut packet = [0u8; 4096];
        for _ in 0..64 { if self.socket.read(&mut packet).is_err() { break; } }
        self.sequence = self.sequence.wrapping_add(1);
        let payload = format!("stellar-local-pf-probe-{}-{}", std::process::id(), self.sequence);
        let destination: SocketAddr = if ipv6 { format!("[fd73:7465:6c6c:6172::2]:{port}") } else { format!("198.18.255.253:{port}") }.parse().unwrap();
        let sender = UdpSocket::bind(if ipv6 { "[::]:0" } else { "0.0.0.0:0" })?;
        sender.set_nonblocking(true)?;
        match sender.send_to(payload.as_bytes(), destination) {
            Ok(_) => {},
            Err(error) if matches!(error.kind(), io::ErrorKind::PermissionDenied | io::ErrorKind::WouldBlock) => {},
            Err(error) => return Err(error),
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            match self.socket.read(&mut packet) {
                Ok(size) if packet[..size].windows(payload.len()).any(|bytes| bytes == payload.as_bytes()) => return Ok(true),
                Ok(_) => {},
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(5)),
                Err(error) => return Err(error),
            }
        }
        Ok(false)
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        if self.ipv6_route { let _ = run("/sbin/route", &["-n", "delete", "-inet6", "-host", "fd73:7465:6c6c:6172::2", "-interface", &self.name]); }
        // File's close tears down its owned utun, including the peer IPv4 route.
        let _ = self.socket.as_raw_fd();
    }
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn apple_control_abi_sizes_match_sdk() { assert_eq!(std::mem::size_of::<ControlInfo>(), 100); assert_eq!(std::mem::size_of::<ControlAddress>(), 32); }
}
