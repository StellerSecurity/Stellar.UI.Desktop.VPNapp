# Exact reviewed hosted Rust/SDK toolchain, locked graph and vendored source only.
# No installer/driver/service registration, GUI launch or production credentials.
param([Parameter(Mandatory = $true)][string] $SourceCommit, [switch] $ExportInterfaceTest, [switch] $PrepareRustOnly)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($SourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'Exact first-party source commit required.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'windows-rust-inputs.json') -Raw | ConvertFrom-Json
$root = Join-Path $env:RUNNER_TEMP ('stellar-rust-source-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)
$sourceInputs = if ($PrepareRustOnly) {
    @($manifest.files | Where-Object path -ceq 'native/windows/rust-build-approval.json')
} else { $manifest.files }
Write-Host 'Fetching the pinned first-party Windows inputs.'
foreach ($entry in $sourceInputs) {
    if ($entry.path -notmatch '^[A-Za-z0-9_.@/-]+$' -or $entry.path -match '(^|/)\.\.(/|$)|\.[mM][dD]$' -or $entry.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Invalid source input pin.' }
    $destination = Join-Path $root $entry.path
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    $url = 'https://raw.githubusercontent.com/StellerSecurity/Stellar.UI.Desktop.VPNapp/' + $SourceCommit + '/' + $entry.path
    $request = [Net.HttpWebRequest]::Create($url)
    $request.AllowAutoRedirect = $false; $request.Timeout = 30000
    $request.ReadWriteTimeout = 30000
    $response = $request.GetResponse()
    try {
        if ($response.ContentLength -gt 8MB) { throw 'Unexpected source file size.' }
        $output = [IO.File]::Create($destination)
        try { $response.GetResponseStream().CopyTo($output) } finally { $output.Dispose() }
    } finally { $response.Dispose() }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) { throw ('First-party source hash mismatch: ' + $entry.path) }
}
Write-Host 'First-party Windows input hashes verified.'
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
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:GITHUB_WORKFLOW_REF -cne $review.vendoredSourceExecutionApproval.githubWorkflowRef -or
    $env:GITHUB_SHA -cne $SourceCommit) {
    throw 'Vendored source execution approval applies only to the recorded GitHub workflow and commit.'
}
$rustRoot = Join-Path $env:RUNNER_TEMP 'stellar-reviewed-rust'
if ($PrepareRustOnly) {
    if (Test-Path -LiteralPath $rustRoot) { throw 'Fresh Rust staging directory required.' }
    [IO.Directory]::CreateDirectory($rustRoot) | Out-Null
    $python = (Get-Command python.exe -CommandType Application -ErrorAction Stop).Source
    $extract = Join-Path $PSScriptRoot 'windows-rust-extract.py'
    # Rust 1.99.1 distributions statically verified and approved for this CI job.
    # Stage their runtime directories only. No package installer is invoked.
    $rustArchives = @(
        @{ name = 'cargo'; component = 'cargo'; bytes = 9881184; sha256 = '4adb46c3707dee790682f7769d86983841148111695f561c843c33daa2af0c9b'; directories = @('bin') },
        @{ name = 'rustc'; component = 'rustc'; bytes = 77075164; sha256 = '7da83c2af1f209606b0160f25174d2867c7c7b73667c32c9e5fbcef4f5f45348'; directories = @('bin', 'lib', 'libexec') },
        @{ name = 'rust-std'; component = 'rust-std-x86_64-pc-windows-msvc'; bytes = 23619148; sha256 = '4fe09430ded40b8b3092b49f0a651178eb1f8154ef4d1f1a73f2a3595b2d956f'; directories = @('lib') }
    )
    foreach ($pin in $rustArchives) {
        $name = $pin.name + '-1.99.1-x86_64-pc-windows-msvc'
        Write-Host "Fetching the pinned $name archive."
        $archive = Join-Path $root ($name + '.tar.xz')
        $request = [Net.HttpWebRequest]::Create('https://static.rust-lang.org/dist/2026-10-15/' + $name + '.tar.xz')
        $request.AllowAutoRedirect = $false
        $request.Timeout = 30000
        $request.ReadWriteTimeout = 30000
        $download = [Diagnostics.Stopwatch]::StartNew()
        $response = $request.GetResponse()
        try {
            if ($response.ContentLength -ne $pin.bytes) { throw 'Rust archive length changed.' }
            $input = $response.GetResponseStream()
            try {
                $output = [IO.File]::Open($archive, [IO.FileMode]::CreateNew)
                try {
                    $buffer = New-Object byte[] 65536
                    $remaining = $pin.bytes
                    while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                        if ($download.Elapsed.TotalMinutes -ge 3) { throw 'Rust archive download exceeded three minutes.' }
                        $remaining -= $count
                        if ($remaining -lt 0) { throw 'Rust archive exceeds reviewed size.' }
                        $output.Write($buffer, 0, $count)
                    }
                    if ($remaining -ne 0) { throw 'Truncated Rust archive.' }
                } finally { $output.Dispose() }
            } finally { $input.Dispose() }
        } finally { $response.Dispose() }
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) {
            throw 'Rust archive does not match its reviewed SHA-256.'
        }
        Write-Host "Extracting the verified $name runtime files."
        $directories = $pin.directories
        & $python -I $extract $archive $rustRoot $name $pin.component @directories
        if ($LASTEXITCODE -ne 0) { throw 'Rust runtime extraction failed.' }
    }
    return
}
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
$rustBin = Join-Path $rustRoot 'bin'
foreach ($pin in $review.rust) {
    if ($pin.name -notmatch '^(cargo\.exe|rustc\.exe|rustc_driver-[a-f0-9]+\.dll)$') { throw 'Unexpected Rust component.' }
    $file = Get-Item -LiteralPath (Join-Path $rustBin $pin.name)
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Rust tool reparse point rejected.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'Rust tool hash changed; re-review required.' }
}
if ((Get-Item -LiteralPath (Join-Path $rustBin 'rustc.exe')).VersionInfo.ProductVersion -ne $review.rustVersion) { throw 'Rust compiler version changed.' }
Write-Host 'Rust executable and compiler DLL hashes verified. Checking the pinned Windows SDK.'
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.26100.0\x64'
$stagedSdk = Join-Path $root 'reviewed-sdk'
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
Write-Host 'Windows SDK hashes and signatures verified. Running native compiler checks.'
# The shared script stages only signed/hash-pinned MSVC and sets INCLUDE/LIB.
& (Join-Path $root 'scripts/windows-native-compile.ps1') -OutputDirectory (Join-Path $root 'native-preflight') -RunSyntheticTests
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
$env:CARGO_HTTP_TIMEOUT = '30'
$env:CARGO_NET_RETRY = '1'
foreach ($name in @('RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'CARGO_REGISTRY_TOKEN', 'CARGO_REGISTRIES_CRATES_IO_TOKEN', 'CARGO_BUILD_RUSTC_WRAPPER', 'CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER', 'RUSTDOCFLAGS')) {
    Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
}
Push-Location $root
try {
    Write-Host 'Fetching the locked Cargo dependency set.'
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
    if ($ExportInterfaceTest) {
        # A standalone UI test, not the installer or VPN runtime. Embed the
        # pinned frontend snapshot instead of depending on a localhost server.
        $uiRoot = Join-Path $root 'native/windows/preview-ui'
        $uiFiles = @($manifest.files | Where-Object { $_.path.StartsWith('native/windows/preview-ui/') })
        if ($uiFiles.Count -ne 6) { throw 'Exact six-file frontend snapshot required.' }
        foreach ($entry in $uiFiles) {
            $relative = $entry.path.Substring('native/windows/preview-ui/'.Length)
            $destination = Join-Path $root ('dist/' + $relative)
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
            [IO.File]::Copy((Join-Path $root $entry.path), $destination)
        }
        & $cargo build --locked --offline --target x86_64-pc-windows-msvc -p stellar-vpn-desktop --features tauri/custom-protocol
        if ($LASTEXITCODE -ne 0) { throw 'Standalone Windows interface build failed.' }
        Verify-Lock
        $output = Join-Path $env:RUNNER_TEMP 'stellar-windows-interface-test'
        if (Test-Path -LiteralPath $output) { throw 'Fresh interface test output required.' }
        [IO.Directory]::CreateDirectory($output) | Out-Null
        $executable = Join-Path $output 'Stellar VPN Interface Test.exe'
        [IO.File]::Copy((Join-Path $env:CARGO_TARGET_DIR 'x86_64-pc-windows-msvc/debug/stellar-vpn-desktop.exe'), $executable)
        $proof = [ordered]@{
            schema = 1; sourceCommit = $SourceCommit; architecture = 'x86_64'; kind = 'standalone-interface-test'
            frontendSnapshot = $uiFiles; executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
            signed = $false; releaseApproved = $false; vpnRuntimeIncluded = $false; serviceIncluded = $false; driverIncluded = $false
            limitation = 'UI test only. No VPN service/driver is installed. Windows ARM cannot load the x64 VPN driver.'
        }
        [IO.File]::WriteAllText((Join-Path $output 'build-info.json'), ($proof | ConvertTo-Json -Depth 5), $utf8)
        $zip = Join-Path $env:RUNNER_TEMP 'stellar-windows-interface-test.zip'
        if (Test-Path -LiteralPath $zip) { throw 'Fresh interface artifact required.' }
        Compress-Archive -LiteralPath $executable, (Join-Path $output 'build-info.json') -DestinationPath $zip -CompressionLevel Optimal
        "STELLAR_WINDOWS_PREVIEW_ZIP=$zip" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
        $proof | ConvertTo-Json -Depth 5 -Compress
        # Separate unsigned first-party input for the documented local signing flow.
        $helper = Join-Path $root 'native-preflight/stellar-vpn-service.exe'
        $helperOutput = Join-Path $env:RUNNER_TEMP 'stellar-windows-unsigned-native-helper'
        $helperZip = $helperOutput + '.zip'
        if ((Test-Path -LiteralPath $helperOutput) -or (Test-Path -LiteralPath $helperZip)) { throw 'Fresh helper artifact required.' }
        if ((Get-AuthenticodeSignature -LiteralPath $helper).Status -ne 'NotSigned') { throw 'Only the unsigned first-party helper may leave CI.' }
        [IO.Directory]::CreateDirectory($helperOutput) | Out-Null
        $stagedHelper = Join-Path $helperOutput 'stellar-vpn-service.exe'
        [IO.File]::Copy($helper, $stagedHelper, $false)
        $helperProof = [ordered]@{
            schema = 1; sourceCommit = $SourceCommit; architecture = 'x86_64'; kind = 'unsigned-native-helper'
            executableSha256 = (Get-FileHash -LiteralPath $stagedHelper -Algorithm SHA256).Hash.ToLowerInvariant()
            signed = $false; releaseApproved = $false; executed = $false; vpnRuntimeIncluded = $false; driverIncluded = $false
        }
        $helperManifest = Join-Path $helperOutput 'build-info.json'
        [IO.File]::WriteAllText($helperManifest, ($helperProof | ConvertTo-Json), $utf8)
        Compress-Archive -LiteralPath $stagedHelper, $helperManifest -DestinationPath $helperZip -CompressionLevel Optimal
        "STELLAR_WINDOWS_HELPER_ZIP=$helperZip" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append

        $nativeTest = Join-Path $root 'native-preflight/native-tests.exe'
        $testOutput = Join-Path $env:RUNNER_TEMP 'stellar-windows-native-synthetic-test'
        $testZip = $testOutput + '.zip'
        if ((Test-Path -LiteralPath $testOutput) -or (Test-Path -LiteralPath $testZip)) { throw 'Fresh native test artifact required.' }
        [IO.Directory]::CreateDirectory($testOutput) | Out-Null
        $stagedTest = Join-Path $testOutput 'native-tests.exe'
        [IO.File]::Copy($nativeTest, $stagedTest, $false)
        $testManifest = Join-Path $testOutput 'build-info.json'
        $testProof = [ordered]@{
            schema = 1; sourceCommit = $SourceCommit; architecture = 'x86_64'; kind = 'native-synthetic-test'
            executableSha256 = (Get-FileHash -LiteralPath $stagedTest -Algorithm SHA256).Hash.ToLowerInvariant()
            signed = $false; releaseApproved = $false; serviceInstalled = $false; driverInstalled = $false
        }
        [IO.File]::WriteAllText($testManifest, ($testProof | ConvertTo-Json), $utf8)
        Compress-Archive -LiteralPath $stagedTest, $testManifest -DestinationPath $testZip -CompressionLevel Optimal
        "STELLAR_WINDOWS_NATIVE_TEST_ZIP=$testZip" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
    }
    [ordered]@{ suite = 'windows-rust-debug-build-and-tests'; sourceCommit = $SourceCommit; lockedArchivesVerified = $archives.Count; releaseApproved = $false; serviceInstalled = $false; driverInstalled = $false; appExecuted = $false } | ConvertTo-Json -Compress
} finally { Pop-Location }
