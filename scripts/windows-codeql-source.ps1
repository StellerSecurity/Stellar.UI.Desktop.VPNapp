# Exact reviewed hosted Rust/SDK toolchain, locked graph and vendored source only.
# No installer/driver/service registration, GUI launch or production credentials.
param([Parameter(Mandatory = $true)][string] $SourceCommit)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($SourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Exact first-party source commit required.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-app-source-inputs.json') -Raw | ConvertFrom-Json
$stage = Join-Path $env:RUNNER_TEMP ('stellar-codeql-stage-' + [Guid]::NewGuid().ToString('N'))
$root = Join-Path $stage 'source'
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
if ($manifest.files.Count -ne 210 -or @($manifest.files.path | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object -Unique).Count -ne 210) { throw 'Exact unique source inventory required.' }
foreach ($entry in $manifest.files) {
    if ($entry.path -notmatch '^[A-Za-z0-9_.@/-]+$' -or $entry.path -match '(^|/)\.\.(/|$)|\.[mM][dD]$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid source input pin.' }
    if ([IO.Path]::IsPathRooted($entry.path)) { throw 'Rooted source path rejected.' }
    $destination = Join-Path $root $entry.path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    if ($entry.sourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Exact per-file source commit required.' }
    $url = 'https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/' + $entry.sourceCommit + '/' + $entry.path
    $request = [Net.HttpWebRequest]::Create($url)
    $request.AllowAutoRedirect = $false; $request.Timeout = 30000; $request.ReadWriteTimeout = 30000; $request.Proxy = $null
    $response = $request.GetResponse()
    try {
        if ($response.ContentLength -gt 8MB) { throw 'Unexpected source file size.' }
        $output = [IO.File]::Create($destination)
        try {
            $stream = $response.GetResponseStream(); $buffer = New-Object byte[] 65536; $total = 0
            while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read; if ($total -gt 8MB) { throw 'Source response byte budget.' }
                $output.Write($buffer, 0, $read)
            }
        } finally { $output.Dispose() }
    } finally { $response.Dispose() }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw ('First-party source hash mismatch: ' + $entry.path) }
}
$review = Get-Content -LiteralPath (Join-Path $root 'native/windows/rust-build-approval.json') -Raw | ConvertFrom-Json
if ($review.approved -ne $true -or $review.scope -ne 'windows-rust-debug-build-and-synthetic-tests' -or $review.releaseApproved -ne $false) { throw 'Exact Rust build execution approval required.' }
if ($review.sdkExecutionApproval.approved -ne $true -or
    $review.sdkExecutionApproval.scope -ne 'exact-installed-sdk-debug-build-and-synthetic-tests' -or
    $review.sdkExecutionApproval.version -ne $review.sdkVersion) {
    throw 'Exact changed SDK execution approval required.'
}
if ($review.vendoredSourceExecutionApproval.approved -ne $true -or
    $review.vendoredSourceExecutionApproval.scope -ne 'exact-embed-resource-3.0.12-stellar-revision-1-debug-build-and-synthetic-tests' -or
    $review.vendoredSourceExecutionApproval.sourcePlanSha256 -ne '32c2344d561eaefef9d3a09010b0158804a36e62fd2b63b219562f066728c289') {
    throw 'Separate execution approval for the exact vendored source patch is required.'
}
if ($review.packages.Count -ne 407) { throw 'Reviewed dependency count changed.' }
if ($review.vendoredSourceExecutionApproval.files.Count -ne 7 -or
    @($review.vendoredSourceExecutionApproval.files.path | Sort-Object -Unique).Count -ne 7) { throw 'Exact seven-file vendored source review required.' }
foreach ($pin in $review.vendoredSourceExecutionApproval.files) {
    if ($pin.path -notmatch '^vendor/embed-resource-3\.0\.12/(Cargo\.toml|LICENSE|stellar-patch\.json|src/(lib|windows_msvc|windows_not_msvc|non_windows)\.rs)$' -or
        $pin.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unexpected vendored source input.' }
    if ((Get-FileHash -LiteralPath (Join-Path $root $pin.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'Reviewed vendored source changed.' }
}
function Verify-Lock {
    $lockPath = Join-Path $root 'Cargo.lock'
    if ((Get-FileHash -LiteralPath $lockPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $review.sourceLockSha256) { throw 'Exact source Cargo.lock changed.' }
    if ($review.firstPartyLockVersion.name -ne 'stellar-vpn-desktop' -or
        $review.firstPartyLockVersion.from -ne '0.1.0' -or $review.firstPartyLockVersion.to -ne '0.5.1') {
        throw 'Unexpected first-party version-only change.'
    }
    # Preserve the original reviewed dependency lock hash. Only the authored app version differs.
    $text = [IO.File]::ReadAllText($lockPath)
    $current = 'name = "stellar-vpn-desktop"' + "`n" + 'version = "0.5.1"'
    $original = 'name = "stellar-vpn-desktop"' + "`n" + 'version = "0.1.0"'
    if ([regex]::Matches($text, [regex]::Escape($current)).Count -ne 1) { throw 'Unique first-party lock entry required.' }
    $normalized = $text.Replace($current, $original)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($utf8.GetBytes($normalized))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    if ($hash -ne $review.lockSha256) { throw 'Reviewed dependency graph changed.' }
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
$stagedSdk = Join-Path $stage 'reviewed-sdk'
[IO.Directory]::CreateDirectory($stagedSdk) | Out-Null
if ($review.sdk.Count -ne 3 -or
    @($review.sdk.name | Sort-Object -Unique).Count -ne 3) { throw 'Exact three-file SDK bundle required.' }
foreach ($pin in $review.sdk) {
    if ($pin.name -notin @('rc.exe', 'rcdll.dll', 'ServicingCommon.dll')) { throw 'Unexpected SDK tool.' }
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
& (Join-Path $root 'scripts/windows-native-compile.ps1') -OutputDirectory (Join-Path $stage 'native-preflight')
$env:PATH = $stagedSdk + ';' + $env:PATH
$env:RC = Join-Path $stagedSdk 'rc.exe'
$env:RC_x86_64_pc_windows_msvc = $env:RC
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = Join-Path $stage 'native-preflight\tools\link.exe'
$env:RUSTC = Join-Path $rustBin 'rustc.exe'
$cargo = Join-Path $rustBin 'cargo.exe'
$env:CARGO_HOME = Join-Path $stage 'cargo-home'
$env:CARGO_TARGET_DIR = Join-Path $stage 'target'
[IO.Directory]::CreateDirectory($env:CARGO_HOME) | Out-Null
$env:CARGO_REGISTRIES_CRATES_IO_PROTOCOL = 'sparse'
$env:CARGO_NET_GIT_FETCH_WITH_CLI = 'false'
foreach ($name in @('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_REGISTRY_TOKEN', 'CARGO_REGISTRIES_CRATES_IO_TOKEN', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'RUSTDOCFLAGS')) {
    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
}
Push-Location $root
try {
    & $cargo fetch --locked
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency fetch failed.' }
    Verify-Lock
    $expected = @{}
    foreach ($pkg in $review.packages) { $expected[$pkg.name + '-' + $pkg.version + '.crate'] = $pkg.checksum }
    $archives = @(Get-ChildItem -LiteralPath (Join-Path $env:CARGO_HOME 'registry\cache') -Filter '*.crate' -File -Recurse)
    if ($archives.Count -ne $expected.Count) { throw 'Incomplete reviewed crate cache.' }
    foreach ($archive in $archives) {
        if (-not $expected.ContainsKey($archive.Name) -or (Get-FileHash -LiteralPath $archive.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$archive.Name]) { throw 'Fetched dependency is outside the reviewed exact graph.' }
    }
    $env:CARGO_NET_OFFLINE = 'true'
    $exported = @{}
    foreach ($name in @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'RC', 'RC_x86_64_pc_windows_msvc', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'RUSTC', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'CARGO_NET_OFFLINE')) {
        $exported[$name] = [string][Environment]::GetEnvironmentVariable($name)
    }
    $state = [ordered]@{ scope = 'reviewed-source-and-build-prerequisites'; sourceRoot = $root; stageRoot = $stage; lockedArchivesVerified = $archives.Count; environment = $exported; appExecuted = $false; signed = $false }
    [IO.File]::WriteAllText((Join-Path $env:RUNNER_TEMP 'source-preparation.json'), ($state | ConvertTo-Json -Depth 5 -Compress), $utf8)
    [ordered]@{ prepared = $true; lockedArchivesVerified = $archives.Count; appExecuted = $false; signed = $false } | ConvertTo-Json -Compress
} finally { Pop-Location }
