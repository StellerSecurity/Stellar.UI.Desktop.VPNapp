//! Native link/address notifications, not a webview timer or an Internet probe.
//! Compare physical link/address snapshots locally; never read Wi-Fi passwords,
//! SSID APIs, account data or packet contents. Nothing is logged or persisted.
use std::sync::{Arc, atomic::{AtomicBool, AtomicU64, Ordering}};

pub struct NetworkChanges {
    revision: Arc<AtomicU64>,
    seen: u64,
    stopping: Arc<AtomicBool>,
    #[cfg(target_os = "windows")]
    physical_stamp: Option<u64>,
}
impl NetworkChanges {
    pub fn new() -> Result<Self, ()> {
        let value = Self { revision: Arc::default(), seen: 0, stopping: Arc::default(),
            #[cfg(target_os = "windows")] physical_stamp: super::windows::network_stamp().ok() };
        #[cfg(target_os = "macos")]
        platform::start(value.revision.clone(), value.stopping.clone())?;
        Ok(value)
    }
    pub fn changed(&mut self) -> bool {
        #[cfg(target_os = "windows")]
        if let Ok(next) = super::windows::network_stamp() {
            // Existing native app monitor polls this. Physical adapters only;
            // VPN-interface creation and webview timers cannot trigger a loop.
            return replace_if_changed(&mut self.physical_stamp, next);
        }
        self.revision_changed()
    }
    fn revision_changed(&mut self) -> bool {
        let revision = self.revision.load(Ordering::Acquire);
        let changed = revision != self.seen;
        self.seen = revision;
        changed
    }
}
impl Drop for NetworkChanges {
    fn drop(&mut self) { self.stopping.store(true, Ordering::Release); }
}

fn replace_if_changed<T: PartialEq>(previous: &mut Option<T>, next: T) -> bool {
    let changed = previous.as_ref().is_some_and(|value| value != &next);
    *previous = Some(next);
    changed
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;
    use std::{ffi::{c_void, CString}, ptr, time::Duration};
    // ABI checked against the installed Apple SystemConfiguration/CoreFoundation SDK.
    #[repr(C)]
    struct Context {
        version: isize, info: *mut c_void, retain: *const c_void,
        release: *const c_void, copy_description: *const c_void,
    }
    #[link(name = "SystemConfiguration", kind = "framework")]
    unsafe extern "C" {
        fn SCDynamicStoreCreate(allocator: *const c_void, name: *const c_void, callback: unsafe extern "C" fn(*const c_void, *const c_void, *mut c_void), context: *mut Context) -> *const c_void;
        fn SCDynamicStoreSetNotificationKeys(store: *const c_void, keys: *const c_void, patterns: *const c_void) -> u8;
        fn SCDynamicStoreCreateRunLoopSource(allocator: *const c_void, store: *const c_void, order: isize) -> *const c_void;
        fn SCDynamicStoreCopyMultiple(store: *const c_void, keys: *const c_void, patterns: *const c_void) -> *const c_void;
    }
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFStringCreateWithCString(allocator: *const c_void, text: *const i8, encoding: u32) -> *const c_void;
        fn CFArrayCreate(allocator: *const c_void, values: *const *const c_void, count: isize, callbacks: *const c_void) -> *const c_void;
        fn CFRelease(value: *const c_void);
        fn CFEqual(first: *const c_void, second: *const c_void) -> u8;
        fn CFGetTypeID(value: *const c_void) -> usize;
        fn CFDictionaryGetTypeID() -> usize;
        fn CFDictionaryCreateMutable(allocator: *const c_void, capacity: isize, keys: *const c_void, values: *const c_void) -> *const c_void;
        fn CFDictionaryGetCount(dictionary: *const c_void) -> isize;
        fn CFDictionaryGetKeysAndValues(dictionary: *const c_void, keys: *mut *const c_void, values: *mut *const c_void);
        fn CFDictionaryGetValue(dictionary: *const c_void, key: *const c_void) -> *const c_void;
        fn CFDictionarySetValue(dictionary: *const c_void, key: *const c_void, value: *const c_void);
        fn CFRunLoopGetCurrent() -> *const c_void;
        fn CFRunLoopAddSource(run_loop: *const c_void, source: *const c_void, mode: *const c_void);
        fn CFRunLoopRemoveSource(run_loop: *const c_void, source: *const c_void, mode: *const c_void);
        fn CFRunLoopRunInMode(mode: *const c_void, seconds: f64, return_after_source: u8) -> i32;
        static kCFRunLoopDefaultMode: *const c_void;
        static kCFTypeArrayCallBacks: c_void;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }
    struct Owned(*const c_void);
    impl Owned {
        fn new(value: *const c_void) -> Result<Self, ()> { if value.is_null() { Err(()) } else { Ok(Self(value)) } }
        fn string(text: &str) -> Result<Self, ()> {
            let text = CString::new(text).map_err(|_| ())?;
            Self::new(unsafe { CFStringCreateWithCString(ptr::null(), text.as_ptr(), 0x08000100) })
        }
        fn array(values: &[Self]) -> Result<Self, ()> {
            let pointers: Vec<_> = values.iter().map(|value| value.0).collect();
            Self::new(unsafe { CFArrayCreate(ptr::null(), pointers.as_ptr(), pointers.len() as isize, ptr::addr_of!(kCFTypeArrayCallBacks).cast()) })
        }
        fn dictionary() -> Result<Self, ()> {
            Self::new(unsafe { CFDictionaryCreateMutable(ptr::null(), 0, ptr::addr_of!(kCFTypeDictionaryKeyCallBacks).cast(), ptr::addr_of!(kCFTypeDictionaryValueCallBacks).cast()) })
        }
    }
    impl Drop for Owned { fn drop(&mut self) { unsafe { CFRelease(self.0) }; } }
    impl PartialEq for Owned {
        fn eq(&self, other: &Self) -> bool { unsafe { CFEqual(self.0, other.0) != 0 } }
    }
    struct WatchState { revision: Arc<AtomicU64>, previous: Option<Owned>, patterns: *const c_void }
    fn stable_snapshot(source: &Owned) -> Result<Owned, ()> {
        // Signal strength, reachability, timestamps and other ancillary fields
        // can update without a new network. Only transport identity matters.
        let fields = ["Active", "Addresses", "SubnetMasks", "Router"].map(Owned::string);
        let fields = fields.into_iter().collect::<Result<Vec<_>, _>>()?;
        let count = unsafe { CFDictionaryGetCount(source.0) };
        if !(0..=128).contains(&count) { return Err(()); }
        let mut keys = vec![ptr::null(); count as usize];
        let mut values = keys.clone();
        unsafe { CFDictionaryGetKeysAndValues(source.0, keys.as_mut_ptr(), values.as_mut_ptr()) };
        let result = Owned::dictionary()?;
        for (key, value) in keys.into_iter().zip(values) {
            if value.is_null() || unsafe { CFGetTypeID(value) != CFDictionaryGetTypeID() } { continue; }
            let selected = Owned::dictionary()?;
            for field in &fields {
                let value = unsafe { CFDictionaryGetValue(value, field.0) };
                if !value.is_null() { unsafe { CFDictionarySetValue(selected.0, field.0, value) }; }
            }
            if unsafe { CFDictionaryGetCount(selected.0) } > 0 { unsafe { CFDictionarySetValue(result.0, key, selected.0) }; }
        }
        Ok(result)
    }
    fn snapshot(store: *const c_void, patterns: *const c_void) -> Result<Owned, ()> {
        let source = Owned::new(unsafe { SCDynamicStoreCopyMultiple(store, ptr::null(), patterns) })?;
        stable_snapshot(&source)
    }
    unsafe extern "C" fn changed(store: *const c_void, _: *const c_void, info: *mut c_void) {
        // This state/source are owned by the same run-loop thread. Repeated OS
        // notifications with equal data must never trigger another reconnection.
        if info.is_null() { return; }
        let state = unsafe { &mut *info.cast::<WatchState>() };
        if let Ok(snapshot) = snapshot(store, state.patterns) {
            if replace_if_changed(&mut state.previous, snapshot) { state.revision.fetch_add(1, Ordering::Release); }
        }
    }
    pub fn start(revision: Arc<AtomicU64>, stopping: Arc<AtomicBool>) -> Result<(), ()> {
        let (ready, registration) = std::sync::mpsc::sync_channel(1);
        let cancellation = stopping.clone();
        std::thread::Builder::new().name("stellar-network-changes".into()).spawn(move || {
            let registered = (|| {
                let name = Owned::string("Stellar VPN network changes")?;
                // Global/IPv4 and Global/IPv6 also change when VPN routes are
                // installed. They caused a self-triggering reconnect loop.
                // Observe physical interfaces only, and compare actual values.
                let patterns = Owned::array(&[Owned::string("^State:/Network/Interface/en[0-9]+/(Link|IPv4|IPv6)$")?])?;
                let mut watch = Box::new(WatchState { revision: revision.clone(), previous: None, patterns: patterns.0 });
                let mut context = Context { version: 0, info: (&mut *watch as *mut WatchState).cast(), retain: ptr::null(), release: ptr::null(), copy_description: ptr::null() };
                let store = Owned::new(unsafe { SCDynamicStoreCreate(ptr::null(), name.0, changed, &mut context) })?;
                watch.previous = Some(snapshot(store.0, patterns.0)?);
                if unsafe { SCDynamicStoreSetNotificationKeys(store.0, ptr::null(), patterns.0) } == 0 { return Err(()); }
                unsafe { changed(store.0, ptr::null(), context.info) };
                let source = Owned::new(unsafe { SCDynamicStoreCreateRunLoopSource(ptr::null(), store.0, 0) })?;
                let run_loop = unsafe { CFRunLoopGetCurrent() };
                if run_loop.is_null() { return Err(()); }
                unsafe { CFRunLoopAddSource(run_loop, source.0, kCFRunLoopDefaultMode) };
                let _ = ready.send(true);
                while !stopping.load(Ordering::Acquire) {
                    unsafe { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, 1) };
                }
                unsafe { CFRunLoopRemoveSource(run_loop, source.0, kCFRunLoopDefaultMode) };
                Ok::<(), ()>(())
            })();
            if registered.is_err() { let _ = ready.send(false); }
            drop(revision);
        }).map_err(|_| ())?;
        if registration.recv_timeout(Duration::from_secs(3)) == Ok(true) { Ok(()) }
        else { cancellation.store(true, Ordering::Release); Err(()) }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn ancillary_link_updates_do_not_look_like_network_changes() {
            let root = Owned::dictionary().unwrap();
            let link = Owned::dictionary().unwrap();
            let key = Owned::string("State:/Network/Interface/en0/Link").unwrap();
            let active = Owned::string("Active").unwrap();
            let quality = Owned::string("LinkQuality").unwrap();
            let on = Owned::string("on").unwrap();
            let off = Owned::string("off").unwrap();
            unsafe { CFDictionarySetValue(link.0, active.0, on.0); CFDictionarySetValue(root.0, key.0, link.0); }
            let first = stable_snapshot(&root).unwrap();
            unsafe { CFDictionarySetValue(link.0, quality.0, on.0); }
            assert!(first == stable_snapshot(&root).unwrap());
            unsafe { CFDictionarySetValue(link.0, quality.0, off.0); }
            assert!(first == stable_snapshot(&root).unwrap());
            unsafe { CFDictionarySetValue(link.0, active.0, off.0); }
            assert!(first != stable_snapshot(&root).unwrap());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_events_coalesce_and_are_not_lost_when_work_is_busy() {
        let mut watcher = NetworkChanges { revision: Arc::default(), seen: 0, stopping: Arc::default(),
            #[cfg(target_os = "windows")] physical_stamp: None };
        assert!(!watcher.revision_changed());
        watcher.revision.fetch_add(3, Ordering::Release);
        assert!(watcher.revision_changed()); assert!(!watcher.revision_changed());
        watcher.revision.fetch_add(1, Ordering::Release);
        assert!(watcher.revision_changed());
    }
    #[test]
    fn repeated_notifications_with_unchanged_physical_state_never_reconnect() {
        let mut previous = None;
        assert!(!replace_if_changed(&mut previous, (true, vec![1, 2])));
        for _ in 0..100 { assert!(!replace_if_changed(&mut previous, (true, vec![1, 2]))); }
        assert!(replace_if_changed(&mut previous, (false, vec![])));
        assert!(!replace_if_changed(&mut previous, (false, vec![])));
        assert!(replace_if_changed(&mut previous, (true, vec![3, 4])));
        assert!(!replace_if_changed(&mut previous, (true, vec![3, 4])));
    }
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "Read-only native SystemConfiguration registration diagnostic"]
    fn watcher_registers_with_macos() { assert!(NetworkChanges::new().is_ok()); }
}
