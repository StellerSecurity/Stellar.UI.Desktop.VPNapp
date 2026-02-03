// src-tauri/src/macos_installer.rs
// NOTE: All comments in English (per your preference).

#![cfg(target_os = "macos")]

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::{Duration, Instant},
};

use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

const LABEL: &str = "org.stellarsecurity.vpn.helper";

// Where the root helper binary must live (LaunchDaemon-safe location)
const HELPER_INSTALL_PATH: &str = "/Library/PrivilegedHelperTools/stellar-vpn-helper-macos";

// LaunchDaemon plist location
const DAEMON_PLIST_PATH: &str = "/Library/LaunchDaemons/org.stellarsecurity.vpn.helper.plist";

// Socket path used by your helper
pub const SOCKET_PATH: &str = "/tmp/stellar-vpn-helper.sock";

// Helper logs (optional but extremely useful for debugging)
const STDOUT_LOG: &str = "/var/log/stellar-vpn-helper.log";
const STDERR_LOG: &str = "/var/log/stellar-vpn-helper.err.log";

/// Ensure the privileged root helper is installed and running.
/// - Prompts user for password once (via AppleScript admin prompt).
/// - Installs/updates:
///   - /Library/PrivilegedHelperTools/stellar-vpn-helper-macos
///   - /Library/LaunchDaemons/org.stellarsecurity.vpn.helper.plist
/// - Bootstraps LaunchDaemon and kickstarts it.
/// - Waits briefly for the socket to appear.
pub fn ensure_root_helper_installed<RT: Runtime>(app: &AppHandle<RT>) -> Result<(), String> {
    // 1) Find the helper binary packaged with the app
    let helper_src = resolve_packaged_helper(app)?;

    // 2) If already running (socket exists), we are done
    if Path::new(SOCKET_PATH).exists() {
        return Ok(());
    }

    // 3) Install/update files + start daemon (admin prompt)
    install_or_update_files(&helper_src)?;

    // 4) Wait for socket (daemon should create it)
    wait_for_socket(Duration::from_secs(4))?;

    Ok(())
}

/// Resolve helper binary shipped with the app.
/// We try Resource dir first (recommended for production), then fall back to CARGO_MANIFEST_DIR/bin for dev.
fn resolve_packaged_helper<RT: Runtime>(app: &AppHandle<RT>) -> Result<PathBuf, String> {
    // If you add this binary in tauri.conf.json -> bundle.resources, Resource is the right place.
    if let Ok(p) = app
        .path()
        .resolve("bin/stellar-vpn-helper-macos", BaseDirectory::Resource)
    {
        if p.exists() {
            return Ok(p);
        }
    }

    // Dev fallback: src-tauri/bin/stellar-vpn-helper-macos (if build.rs copied it there)
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("bin")
        .join("stellar-vpn-helper-macos");

    if dev.exists() {
        return Ok(dev);
    }

    Err(
        "macOS helper binary not found. Expected in app resources as bin/stellar-vpn-helper-macos or in src-tauri/bin/stellar-vpn-helper-macos."
            .to_string(),
    )
}

/// Build LaunchDaemon plist content.
/// Keep it minimal and LaunchDaemon-compatible.
fn build_plist() -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>

    <key>ProgramArguments</key>
    <array>
      <string>{helper}</string>
      <string>--socket</string>
      <string>{socket}</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>{stdout}</string>

    <key>StandardErrorPath</key>
    <string>{stderr}</string>
  </dict>
</plist>
"#,
        label = LABEL,
        helper = HELPER_INSTALL_PATH,
        socket = SOCKET_PATH,
        stdout = STDOUT_LOG,
        stderr = STDERR_LOG
    )
}

/// Install helper + plist and start the daemon.
/// IMPORTANT: No `sudo` inside this script. The whole script is already elevated via osascript.
fn install_or_update_files(helper_src: &Path) -> Result<(), String> {
    let plist_content = build_plist();

    // We run everything inside one admin prompt.
    // Also remove quarantine from the installed helper (common reason launchd refuses to run it).
    let cmd = format!(
        r#"
set -e

mkdir -p /Library/PrivilegedHelperTools
mkdir -p /Library/LaunchDaemons

# install helper
cp "{helper_src}" "{helper_dst}"
chown root:wheel "{helper_dst}"
chmod 755 "{helper_dst}"

# remove quarantine (if present)
xattr -dr com.apple.quarantine "{helper_dst}" 2>/dev/null || true

# write plist
cat > "{plist_path}" << 'PLISTEOF'
{plist}
PLISTEOF

chown root:wheel "{plist_path}"
chmod 644 "{plist_path}"

# validate plist (prevents vague "Bootstrap failed: 5" issues)
plutil -lint "{plist_path}"

# ensure log files exist (optional)
touch "{stdout_log}" "{stderr_log}" || true
chmod 644 "{stdout_log}" "{stderr_log}" || true

# stop previous instance (ignore errors)
launchctl bootout system/{label} 2>/dev/null || true

# load new
launchctl bootstrap system "{plist_path}"
launchctl kickstart -k system/{label}

exit 0
"#,
        helper_src = helper_src.display(),
        helper_dst = HELPER_INSTALL_PATH,
        plist_path = DAEMON_PLIST_PATH,
        plist = plist_content,
        label = LABEL,
        stdout_log = STDOUT_LOG,
        stderr_log = STDERR_LOG
    );

    run_admin(&cmd)
}

/// Wait for the helper socket to appear.
fn wait_for_socket(timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if Path::new(SOCKET_PATH).exists() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(120));
    }

    Err(format!(
        "Helper did not create socket at {SOCKET_PATH}. Check launchd logs and {STDERR_LOG}."
    ))
}

/// Run an elevated shell script through AppleScript.
/// This will show the system password prompt.
fn run_admin(script: &str) -> Result<(), String> {
    let osa = format!(
        r#"do shell script "{}" with administrator privileges"#,
        escape_for_osascript(script)
    );

    let out = Command::new("osascript")
        .args(["-e", &osa])
        .output()
        .map_err(|e| format!("Failed to execute osascript: {e}"))?;

    if out.status.success() {
        return Ok(());
    }

    let code = out.status.code();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();

    Err(format!(
        "Command failed (code={code:?}).\nstdout:\n{stdout}\nstderr:\n{stderr}"
    ))
}

/// Escape a multi-line shell script so it can be embedded safely inside an AppleScript string.
/// AppleScript string is wrapped in double quotes, so we must escape:
/// - backslashes
/// - double quotes
/// - newlines to \n
fn escape_for_osascript(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

/// Optional: Uninstall helper + daemon (useful for dev/reset).
#[allow(dead_code)]
pub fn uninstall_root_helper() -> Result<(), String> {
    let cmd = format!(
        r#"
set -e

launchctl bootout system/{label} 2>/dev/null || true

rm -f "{plist_path}" || true
rm -f "{helper_path}" || true
rm -f "{socket_path}" || true

exit 0
"#,
        label = LABEL,
        plist_path = DAEMON_PLIST_PATH,
        helper_path = HELPER_INSTALL_PATH,
        socket_path = SOCKET_PATH
    );

    run_admin(&cmd)
}
