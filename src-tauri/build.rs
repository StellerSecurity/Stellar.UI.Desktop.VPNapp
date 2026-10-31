fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        // One reviewed implementation validates exact hashes/signatures and uses
        // absolute compiler paths. Never invoke a PATH-selected cl/lib/link.
        let workspace = std::path::PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap()).join("..");
        let root = workspace.join("native/windows");
        let script = workspace.join("scripts/windows-native-compile.ps1");
        let review = workspace.join(".security-review/windows-native-compile-approval.json");
        assert!(review.is_file(), "Explicit exact Windows toolchain approval is required");
        for file in ["bridge.cpp", "common.hpp", "service.cpp", "firewall.hpp", "lifecycle.hpp", "bridge-link-test.cpp"] {
            println!("cargo:rerun-if-changed={}", root.join(file).display());
        }
        println!("cargo:rerun-if-changed={}", script.display());
        println!("cargo:rerun-if-changed={}", review.display());
        let nonce = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let out = std::path::PathBuf::from(std::env::var("OUT_DIR").unwrap()).join(format!("stellar-native-{}-{nonce}", std::process::id()));
        let powershell = std::path::PathBuf::from(std::env::var("SystemRoot").expect("Windows system directory required"))
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        assert!(powershell.is_absolute() && powershell.is_file(), "Built-in Windows PowerShell required");
        let status = std::process::Command::new(powershell)
            .args(["-NoProfile", "-NonInteractive", "-File"]).arg(script)
            .arg("-OutputDirectory").arg(&out).status().expect("Reviewed Windows native build script unavailable");
        assert!(status.success() && out.join("stellar_windows.lib").is_file(), "Verified Windows native compilation failed");
        println!("cargo:rustc-link-search=native={}", out.display());
        for library in ["static=stellar_windows", "advapi32", "shell32", "ole32", "wintrust", "crypt32", "ws2_32", "iphlpapi", "winhttp", "fwpuclnt", "rpcrt4", "wtsapi32", "bcrypt", "uuid"] { println!("cargo:rustc-link-lib={library}"); }
    }
    tauri_build::build()
}
