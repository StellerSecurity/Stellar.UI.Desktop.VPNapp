//! Bounded use of macOS system tools. No shell, inherited secrets or curlrc.
use super::trust::{failure, unavailable};
use std::{io::Read, process::{Command, Stdio}, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use stellar_core::domain::AppError;

pub fn run(mut command: Command, stderr: bool, max: usize, seconds: u64, cancel: Arc<AtomicBool>, mut consume: impl FnMut(&[u8]) -> Result<(), AppError>) -> Result<(), AppError> {
    if cancel.load(Ordering::SeqCst) { return Err(failure()); }
    command.env_clear().stdin(Stdio::null()).stdout(if stderr { Stdio::null() } else { Stdio::piped() }).stderr(if stderr { Stdio::piped() } else { Stdio::null() });
    let mut child = command.spawn().map_err(|_| unavailable())?;
    let mut pipe: Box<dyn Read> = if stderr { Box::new(child.stderr.take().ok_or_else(failure)?) } else { Box::new(child.stdout.take().ok_or_else(failure)?) };
    let child = Arc::new(Mutex::new(child));
    let done = Arc::new(AtomicBool::new(false));
    let (watch_child, watch_done, watch_cancel) = (child.clone(), done.clone(), cancel.clone());
    let watchdog = std::thread::spawn(move || {
        let started = Instant::now();
        while !watch_done.load(Ordering::SeqCst) {
            if watch_cancel.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(seconds) {
                if let Ok(mut child) = watch_child.lock() { let _ = child.kill(); }
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    let result = (|| {
        let mut count = 0usize;
        let mut buffer = [0; 32 * 1024];
        loop {
            let read = pipe.read(&mut buffer).map_err(|_| unavailable())?;
            if read == 0 { break; }
            count = count.checked_add(read).ok_or_else(failure)?;
            if count > max || cancel.load(Ordering::SeqCst) { return Err(failure()); }
            consume(&buffer[..read])?;
        }
        Ok(())
    })();
    if result.is_err() { if let Ok(mut child) = child.lock() { let _ = child.kill(); } }
    // Keep the watchdog alive while waiting, including tools that close stdout
    // early and continue running. Always reap the process, including failures.
    let status = loop {
        match child.lock().map_err(|_| failure())?.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => std::thread::sleep(Duration::from_millis(10)),
            Err(_) => break Err(unavailable()),
        }
    };
    done.store(true, Ordering::SeqCst);
    let _ = watchdog.join();
    result?;
    if !status?.success() || cancel.load(Ordering::SeqCst) { return Err(unavailable()); }
    Ok(())
}
pub fn capture(command: Command, stderr: bool, max: usize, seconds: u64, cancel: Arc<AtomicBool>) -> Result<Vec<u8>, AppError> {
    let mut bytes = Vec::new();
    run(command, stderr, max, seconds, cancel, |part| { bytes.extend_from_slice(part); Ok(()) })?;
    Ok(bytes)
}
pub fn curl(url: &str, max: usize, seconds: u64) -> Command {
    let mut command = Command::new("/usr/bin/curl");
    command.args(["--disable", "--fail", "--silent", "--show-error", "--proto", "=https", "--proto-redir", "=https", "--location", "--max-redirs", "0", "--tlsv1.2", "--connect-timeout", "5", "--max-time", &seconds.to_string(), "--max-filesize", &max.to_string(), "--url", url]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn subprocesses_have_no_inherited_credentials_and_output_is_bounded() {
        let cancel = Arc::new(AtomicBool::new(false));
        let bytes = capture(Command::new("/usr/bin/env"), false, 4096, 2, cancel.clone()).unwrap();
        assert!(bytes.is_empty());
        let mut echo = Command::new("/bin/echo"); echo.arg("too much output");
        assert!(capture(echo, false, 2, 2, cancel).is_err());
    }
    #[test] fn cancellation_kills_a_stalled_process_without_waiting_for_network_timeout() {
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = cancel.clone();
        let worker = std::thread::spawn(move || { std::thread::sleep(Duration::from_millis(100)); trigger.store(true, Ordering::SeqCst); });
        let mut sleep = Command::new("/bin/sleep"); sleep.arg("10");
        let started = Instant::now();
        assert!(capture(sleep, false, 4096, 15, cancel).is_err());
        worker.join().unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
    }
    #[test] fn watchdog_also_kills_a_tool_that_never_writes_output() {
        let mut sleep = Command::new("/bin/sleep"); sleep.arg("10");
        let started = Instant::now();
        assert!(capture(sleep, false, 4096, 1, Arc::new(AtomicBool::new(false))).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
