//! Authenticate the socket's audit-token identity, not a reusable PID or a caller path.
use std::{ffi::{c_char, c_void, CString}, io, os::{fd::AsRawFd, unix::net::UnixStream}, ptr};

const REQUIREMENT: &str = "anchor apple generic and identifier \"org.stellarsecurity.vpn.desktop\" and certificate leaf[subject.OU] = \"7VYLUCU756\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    static kSecGuestAttributeAudit: *const c_void;
    fn SecCodeCopyGuestWithAttributes(host: *const c_void, attributes: *const c_void, flags: u32, code: *mut *const c_void) -> i32;
    fn SecRequirementCreateWithString(text: *const c_void, flags: u32, requirement: *mut *const c_void) -> i32;
    fn SecCodeCheckValidity(code: *const c_void, flags: u32, requirement: *const c_void) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFDataCreate(allocator: *const c_void, bytes: *const u8, length: isize) -> *const c_void;
    fn CFStringCreateWithCString(allocator: *const c_void, text: *const c_char, encoding: u32) -> *const c_void;
    fn CFDictionaryCreate(allocator: *const c_void, keys: *const *const c_void, values: *const *const c_void, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> *const c_void;
    fn CFRelease(value: *const c_void);
}
unsafe extern "C" {
    fn getsockopt(socket: i32, level: i32, option: i32, value: *mut c_void, length: *mut u32) -> i32;
}
struct Owned(*const c_void);
impl Owned {
    fn checked(value: *const c_void) -> io::Result<Self> {
        if value.is_null() { Err(denied()) } else { Ok(Self(value)) }
    }
}
impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) }; } }
fn denied() -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, "Untrusted VPN client") }

pub fn verify(stream: &UnixStream) -> io::Result<()> {
    let mut audit = [0u32; 8];
    let mut size = std::mem::size_of_val(&audit) as u32;
    // Constants and ABI checked against the installed macOS SDK sys/un.h.
    if unsafe { getsockopt(stream.as_raw_fd(), 0, 0x006, audit.as_mut_ptr().cast(), &mut size) } != 0
        || size as usize != std::mem::size_of_val(&audit) { return Err(denied()); }
    let data = Owned::checked(unsafe { CFDataCreate(ptr::null(), audit.as_ptr().cast(), size as isize) })?;
    let key = unsafe { kSecGuestAttributeAudit };
    let attributes = Owned::checked(unsafe { CFDictionaryCreate(ptr::null(), &key, &data.0, 1, ptr::null(), ptr::null()) })?;
    let mut raw_code = ptr::null();
    let status = unsafe { SecCodeCopyGuestWithAttributes(ptr::null(), attributes.0, 0, &mut raw_code) };
    let code = Owned::checked(raw_code)?;
    if status != 0 { return Err(denied()); }
    let text = CString::new(REQUIREMENT).map_err(|_| denied())?;
    let text = Owned::checked(unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x08000100) })?;
    let mut raw_requirement = ptr::null();
    let status = unsafe { SecRequirementCreateWithString(text.0, 0, &mut raw_requirement) };
    let requirement = Owned::checked(raw_requirement)?;
    if status != 0 || unsafe { SecCodeCheckValidity(code.0, 1 << 4, requirement.0) } != 0 { return Err(denied()); }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unsigned_same_user_socket_client_is_not_authorized() {
        let (client, server) = UnixStream::pair().unwrap();
        let _keep_peer_alive = client;
        let mut audit = [0u32; 8];
        let mut size = std::mem::size_of_val(&audit) as u32;
        assert_eq!(unsafe { getsockopt(server.as_raw_fd(), 0, 0x006, audit.as_mut_ptr().cast(), &mut size) }, 0);
        assert_eq!(size as usize, std::mem::size_of_val(&audit));
        assert!(verify(&server).is_err());
    }
    #[test]
    fn production_requirement_is_valid_and_pins_product_team_and_certificate_class() {
        let text = CString::new(REQUIREMENT).unwrap();
        let text = Owned::checked(unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x08000100) }).unwrap();
        let mut value = ptr::null();
        assert_eq!(unsafe { SecRequirementCreateWithString(text.0, 0, &mut value) }, 0);
        let _owned = Owned::checked(value).unwrap();
        assert!(REQUIREMENT.contains("7VYLUCU756"));
        assert!(REQUIREMENT.contains("org.stellarsecurity.vpn.desktop"));
    }
}
