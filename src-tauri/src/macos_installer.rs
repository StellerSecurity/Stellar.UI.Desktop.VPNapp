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
const HELPER_INSTALL_PATH: &str = "/Library/PrivilegedHelperTools/stellar-vpn-helper-macos";
const DAEMON_PLIST_PATH: &str = "/Library/LaunchDaemons/org.stellarsecurity.vpn.helper.plist";
pub const SOCKET_PATH: &str = "/tmp/stellar-vpn-helper.sock";
const STDOUT_LOG: &str = "/var/log/stellar-vpn-helper.log";
const STDERR_LOG: &str = "/var/log/stellar-vpn-helper.err.log";

pub fn ensure_root_helper_installed<RT: Runtime>(app: &AppHandle<RT>) -> Result<(), String> {
    let helper_src = resolve_packaged_helper(app)?;
    let plist_content = build_plist();

    let helper_missing = !Path::new(HELPER_INSTALL_PATH).exists();
    let plist_missing = !Path::new(DAEMON_PLIST_PATH).exists();

    let helper_changed = if helper_missing {
        true
    } else {
        !files_match(&helper_src, Path::new(HELPER_INSTALL_PATH))?
    };

    let plist_changed = if plist_missing {
        true
    } else {
        !plist_matches(Path::new(DAEMON_PLIST_PATH), &plist_content)?
    };

    let socket_missing = !Path::new(SOCKET_PATH).exists();

    if !helper_changed && !plist_changed && !socket_missing {
        return Ok(());
    }

    install_or_update_files(&helper_src, &plist_content)?;
    wait_for_socket(Duration::from_secs(6))?;

    Ok(())
}

fn resolve_packaged_helper<RT: Runtime>(app: &AppHandle<RT>) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Primary: signed bundled resource copy of the mac helper
    if let Ok(p) = app
        .path()
        .resolve("bin/stellar-vpn-helper-macos", BaseDirectory::Resource)
    {
        candidates.push(p);
    }

    if let Ok(p) = app
        .path()
        .resolve("stellar-vpn-helper-macos", BaseDirectory::Resource)
    {
        candidates.push(p);
    }

    // Dev fallback: target/release helper
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("release")
            .join("stellar-vpn-helper-macos"),
    );

    // Dev fallback: copied helper in src-tauri/bin
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join("stellar-vpn-helper-macos"),
    );

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(
        "macOS helper binary not found. Expected in app resources as bin/stellar-vpn-helper-macos, or dev fallbacks in src-tauri/target/release or src-tauri/bin."
            .to_string(),
    )
}

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

fn install_or_update_files(helper_src: &Path, plist_content: &str) -> Result<(), String> {
    let cmd = format!(
        r#"
set -e

mkdir -p /Library/PrivilegedHelperTools
mkdir -p /Library/LaunchDaemons

cp "{helper_src}" "{helper_dst}"
chown root:wheel "{helper_dst}"
chmod 755 "{helper_dst}"

xattr -dr com.apple.quarantine "{helper_dst}" 2>/dev/null || true

cat > "{plist_path}" << 'PLISTEOF'
{plist}
PLISTEOF

chown root:wheel "{plist_path}"
chmod 644 "{plist_path}"
plutil -lint "{plist_path}"

touch "{stdout_log}" "{stderr_log}" || true
chmod 644 "{stdout_log}" "{stderr_log}" || true

rm -f "{socket_path}" || true

launchctl bootout system/{label} 2>/dev/null || true
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
        stderr_log = STDERR_LOG,
        socket_path = SOCKET_PATH,
    );

    run_admin(&cmd)
}

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

fn files_match(a: &Path, b: &Path) -> Result<bool, String> {
    let a_bytes =
        fs::read(a).map_err(|e| format!("Failed to read {}: {e}", a.display()))?;
    let b_bytes =
        fs::read(b).map_err(|e| format!("Failed to read {}: {e}", b.display()))?;
    Ok(a_bytes == b_bytes)
}

fn plist_matches(path: &Path, expected: &str) -> Result<bool, String> {
    let current = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
    Ok(normalize_newlines(&current).trim() == normalize_newlines(expected).trim())
}

fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n")
}

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

fn escape_for_osascript(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

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
        socket_path = SOCKET_PATH,
    );

    run_admin(&cmd)
}