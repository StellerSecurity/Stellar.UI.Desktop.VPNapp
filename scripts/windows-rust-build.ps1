# Exact reviewed hosted Rust/SDK toolchain and locked source graph only.
# No installer/driver/service registration, GUI launch or production credentials.
param([Parameter(Mandatory = $true)][string] $SourceCommit)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($SourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Exact first-party source commit required.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-rust-inputs.json') -Raw | ConvertFrom-Json
$root = Join-Path $env:RUNNER_TEMP ('stellar-rust-source-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
foreach ($entry in $manifest.files) {
    if ($entry.path -notmatch '^[A-Za-z0-9_.@/-]+$' -or $entry.path -match '(^|/)\.\.(/|$)|\.[mM][dD]$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid source input pin.' }
    $destination = Join-Path $root $entry.path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    $url = 'https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/' + $SourceCommit + '/' + $entry.path
    $request = [Net.HttpWebRequest]::Create($url)
    $request.AllowAutoRedirect = $false; $request.Timeout = 30000
    $response = $request.GetResponse()
    try {
        if ($response.ContentLength -gt 8MB) { throw 'Unexpected source file size.' }
        $output = [IO.File]::Create($destination)
        try { $response.GetResponseStream().CopyTo($output) } finally { $output.Dispose() }
    } finally { $response.Dispose() }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw ('First-party source hash mismatch: ' + $entry.path) }
}
$review = Get-Content -LiteralPath (Join-Path $root 'native/windows/rust-build-approval.json') -Raw | ConvertFrom-Json
if ($review.approved -ne $true -or $review.scope -ne 'windows-rust-debug-build-and-synthetic-tests' -or $review.releaseApproved -ne $false) { throw 'Exact Rust build execution approval required.' }
if ($review.packages.Count -ne 410) { throw 'Reviewed dependency count changed.' }
function Verify-Lock {
    if ((Get-FileHash -LiteralPath (Join-Path $root 'Cargo.lock') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $review.lockSha256) { throw 'Reviewed Cargo.lock changed.' }
}
Verify-Lock
$rustBin = Join-Path $env:USERPROFILE '.rustup\toolchains\stable-x86_64-pc-windows-msvc\bin'
foreach ($pin in $review.rust) {
    if ($pin.name -notmatch '^(cargo\.exe|rustc\.exe|rustc_driver-[a-f0-9]+\.dll)$') { throw 'Unexpected Rust component.' }
    $file = Get-Item -LiteralPath (Join-Path $rustBin $pin.name)
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Rust tool reparse point rejected.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'Rust tool hash changed; re-review required.' }
}
if ((Get-Item -LiteralPath (Join-Path $rustBin 'rustc.exe')).VersionInfo.ProductVersion -ne $review.rustVersion) { throw 'Rust compiler version changed.' }
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.26100.0\x64'
$stagedSdk = Join-Path $root 'reviewed-sdk'
[IO.Directory]::CreateDirectory($stagedSdk) | Out-Null
foreach ($pin in $review.sdk) {
    if ($pin.name -notin @('rc.exe', 'rcdll.dll')) { throw 'Unexpected SDK tool.' }
    $file = Get-Item -LiteralPath (Join-Path $sdkBin $pin.name)
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SDK tool reparse point rejected.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256 -or $file.VersionInfo.ProductVersion -ne $review.sdkVersion) { throw 'SDK tool changed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $pin.signer) { throw 'Pinned Microsoft SDK signature required.' }
    [IO.File]::Copy($file.FullName, (Join-Path $stagedSdk $pin.name))
}
$security = Join-Path $root '.security-review'
[IO.Directory]::CreateDirectory($security) | Out-Null
[IO.File]::Copy((Join-Path $root 'native/windows/compile-approval.json'), (Join-Path $security 'windows-native-compile-approval.json'))
# The shared script stages only signed/hash-pinned MSVC and sets INCLUDE/LIB.
& (Join-Path $root 'scripts/windows-native-compile.ps1') -OutputDirectory (Join-Path $root 'native-preflight')
$env:PATH = $stagedSdk + ';' + $env:PATH
$env:RC = Join-Path $stagedSdk 'rc.exe'
$env:RC_x86_64_pc_windows_msvc = $env:RC
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $root 'native-preflight\tools\link.exe'
$env:RUSTC = Join-Path $rustBin 'rustc.exe'
$cargo = Join-Path $rustBin 'cargo.exe'
$env:CARGO_HOME = Join-Path $root 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $root 'target'
[IO.Directory]::CreateDirectory($env:CARGO_HOME) | Out-Null
$env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse'
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'false'
foreach ($name in @('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_REGISTRY_TOKEN', 'CARGO_REGISTRIES_CRATES_IO_TOKEN', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'RUSTDOCFLAGS')) {
    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
}
Push-Location $root
try {
    & $cargo fetch --locked --target x86_64-pc-windows-msvc
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency fetch failed.' }
    Verify-Lock
    $expected = @{}
    foreach ($pkg in $review.packages) { $expected[$pkg.name + '-' + $pkg.version + '.crate'] = $pkg.checksum }
    $archives = @(Get-ChildItem -LiteralPath (Join-Path $env:CARGO_HOME 'registry\cache') -Filter '*.crate' -File -Recurse)
    foreach ($archive in $archives) {
        if (-not $expected.ContainsKey($archive.Name) -or (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$archive.Name]) { throw 'Fetched dependency is outside the reviewed exact graph.' }
    }
    $env:CARGO_NET_OFFLINE = 'true'
    & $cargo test --locked --offline --target x86_64-pc-windows-msvc -p stellar-core --lib
    if ($LASTEXITCODE -ne 0) { throw 'Windows core Rust tests failed.' }
    Verify-Lock
    & $cargo test --locked --offline --target x86_64-pc-windows-msvc -p stellar-vpn-desktop --lib
    if ($LASTEXITCODE -ne 0) { throw 'Windows desktop Rust tests failed.' }
    Verify-Lock
    & $cargo test --locked --offline --target x86_64-pc-windows-msvc -p stellar-vpn-desktop --lib infrastructure::session::tests::windows_vault_round_trip_and_delete -- --ignored --exact
    if ($LASTEXITCODE -ne 0) { throw 'Synthetic Windows Credential Manager test failed.' }
    Verify-Lock
    & $cargo build --locked --offline --target x86_64-pc-windows-msvc -p stellar-vpn-desktop
    if ($LASTEXITCODE -ne 0) { throw 'Windows desktop debug build failed.' }
    Verify-Lock
    [ordered]@{ suite = 'windows-rust-debug-build-and-tests'; sourceCommit = $SourceCommit; lockedArchivesVerified = $archives.Count; releaseApproved = $false; serviceInstalled = $false; driverInstalled = $false; appExecuted = $false } | ConvertTo-Json -Compress
} finally { Pop-Location }
