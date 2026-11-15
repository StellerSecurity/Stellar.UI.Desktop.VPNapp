# First-party native compilation and optional isolated synthetic tests. No
# installs/downloads, service/driver registration, signing or packaging.
param([Parameter(Mandatory = $true)][string] $SourceRoot, [Parameter(Mandatory = $true)][string] $OutputDirectory, [Parameter(Mandatory = $true)][string] $StateFile)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows required.' }
$root = [IO.Path]::GetFullPath($SourceRoot)
$approvalPath = Join-Path $root 'native\windows\compile-approval.json'
if (-not (Test-Path -LiteralPath $approvalPath -PathType Leaf)) { throw 'Explicit reviewed toolchain execution approval is missing.' }
$review = Get-Content -LiteralPath $approvalPath -Raw | ConvertFrom-Json
if ($review.approved -ne $true -or $review.scope -ne 'native-cpp-compile-only' -or
    $review.compilerVersion -ne '14.44.35230.0' -or $review.sdkDirectory -ne '10.0.26100.0') {
    throw 'This exact compiler/SDK pair is not approved for native compilation.'
}
if ($review.toolchainExecutionApproval.approved -ne $true -or
    $review.toolchainExecutionApproval.scope -ne 'exact-installed-msvc-debug-build-and-synthetic-tests' -or
    $review.toolchainExecutionApproval.version -ne $review.compilerVersion) {
    throw 'Exact changed MSVC execution approval required.'
}
$vc = Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207'
$bin = Join-Path $vc 'bin\Hostx64\x64'
$sdk = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'
$tools = @{}
$pins = @($review.components)
if ($pins.Count -lt 3 -or $pins.Count -gt 100) { throw 'Missing exact MSVC component pins.' }
foreach ($pin in $pins) {
    if ($pin.name -notmatch '^(?:[A-Za-z0-9_.-]+\.(exe|dll)|1033/(?:clui|linkui)\.dll)$' -or $pin.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]::IsNullOrEmpty($pin.signer)) { throw 'Invalid toolchain pin.' }
    $file = Get-Item -LiteralPath (Join-Path $bin $pin.name)
    if ($pin.name.StartsWith('1033/')) {
        $languageDirectory = Get-Item -LiteralPath (Join-Path $bin '1033')
        if ($languageDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Resource directory reparse point rejected.' }
        if ($file.VersionInfo.ProductVersion -ne $review.compilerVersion) { throw 'Compiler resource version changed.' }
    }
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Toolchain reparse point rejected.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'Toolchain hash changed; re-review required.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $pin.signer -or
        $pin.signer -notmatch '(^|,\s*)O=Microsoft Corporation(,|$)') { throw 'Valid pinned Microsoft tool signature required.' }
    $tools[$pin.name] = $file.FullName
}
foreach ($name in @('cl.exe', 'lib.exe', 'link.exe')) {
    if (-not $tools.ContainsKey($name)) { throw 'Required Microsoft tool pin missing.' }
    if ((Get-Item -LiteralPath $tools[$name]).VersionInfo.ProductVersion -ne $review.compilerVersion) { throw 'Tool version changed.' }
}
# Fail closed if the compiler directory gained an unreviewed executable/DLL.
foreach ($file in Get-ChildItem -LiteralPath $bin -File) {
    if ($file.Extension -in @('.exe', '.dll') -and -not $tools.ContainsKey($file.Name)) { throw 'Unreviewed compiler component present.' }
}
$include = @((Join-Path $vc 'include'))
foreach ($part in @('ucrt', 'shared', 'um', 'winrt')) { $include += Join-Path $sdk ('Include\10.0.26100.0\' + $part) }
$libraries = @((Join-Path $vc 'lib\x64'), (Join-Path $sdk 'Lib\10.0.26100.0\ucrt\x64'), (Join-Path $sdk 'Lib\10.0.26100.0\um\x64'))
foreach ($directory in @($vc, $bin) + $include + $libraries) {
    $item = Get-Item -LiteralPath $directory
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected compiler/SDK directory.' }
}
# Use an isolated compiler copy without Visual Studio telemetry/remote-config
# components. No installed tool is renamed, removed or modified.
if ([string]::IsNullOrEmpty($OutputDirectory)) {
    $out = Join-Path $env:RUNNER_TEMP ('stellar-native-compile-' + [Guid]::NewGuid().ToString('N'))
} else {
    if (-not [IO.Path]::IsPathRooted($OutputDirectory)) { throw 'An absolute build output directory is required.' }
    $out = [IO.Path]::GetFullPath($OutputDirectory)
    if (Test-Path -LiteralPath $out) { throw 'Build output must be a fresh directory.' }
    $parent = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($out))
    if (-not $parent.PSIsContainer -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected build output parent.' }
}
$stagedBin = Join-Path $out 'tools'
[IO.Directory]::CreateDirectory($stagedBin) | Out-Null
$stagedTools = @{}
foreach ($pin in $pins) {
    $nativeExecutable = $pin.name -in @('cl.exe', 'lib.exe', 'link.exe', 'cvtres.exe', 'mspdbsrv.exe')
    $nativeLibrary = $pin.name.EndsWith('.dll') -and $pin.name -notmatch '^(Microsoft\.|System\.|Newtonsoft\.)' -and $pin.name -ne 'd3dcompiler_47.dll'
    if (-not ($nativeExecutable -or $nativeLibrary)) { continue }
    $destination = Join-Path $stagedBin $pin.name
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
    [IO.File]::Copy($tools[$pin.name], $destination, $false)
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256) { throw 'Staged compiler hash changed.' }
    $stagedTools[$pin.name] = $destination
}
$tools = $stagedTools
# No vcvars/VsDevCmd or PATH-selected linker. Prevent injected compiler options.
$env:PATH = $stagedBin + ';' + $env:PATH
$env:INCLUDE = $include -join ';'
$env:LIB = $libraries -join ';'
$env:LIBPATH = ''
$env:CL = ''
$env:_CL_ = ''
$env:LINK = ''
$env:_LINK_ = ''

# Verify/stage the same exact three reviewed resource-compiler files. No compiler
# or target program is launched by this preparation helper.
$runtimeReview = Get-Content -LiteralPath (Join-Path $root 'native/windows/rust-build-approval.json') -Raw | ConvertFrom-Json
if ($runtimeReview.sdkExecutionApproval.approved -ne $true -or $runtimeReview.sdkExecutionApproval.version -ne $runtimeReview.sdkVersion -or $runtimeReview.sdk.Count -ne 3) { throw 'Exact reviewed SDK resource tools required.' }
$sdkBin = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.26100.0\x64'
$stagedSdk = Join-Path $out 'sdk'
[IO.Directory]::CreateDirectory($stagedSdk) | Out-Null
foreach ($pin in $runtimeReview.sdk) {
    if ($pin.name -notin @('rc.exe', 'rcdll.dll', 'ServicingCommon.dll')) { throw 'Unexpected SDK resource component.' }
    $file = Get-Item -LiteralPath (Join-Path $sdkBin $pin.name)
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'SDK resource reparse point.' }
    if ((Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.sha256 -or $file.VersionInfo.ProductVersion -ne $runtimeReview.sdkVersion) { throw 'SDK resource component changed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne $pin.signer) { throw 'Exact valid Microsoft SDK signature required.' }
    [IO.File]::Copy($file.FullName, (Join-Path $stagedSdk $pin.name))
}
$env:PATH = $stagedSdk + ';' + $env:PATH
$env:RC = Join-Path $stagedSdk 'rc.exe'
$env:RC_x86_64_pc_windows_msvc = $env:RC
$env:CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER = $tools['link.exe']
$env:CC_x86_64_pc_windows_msvc = $tools['cl.exe']
$env:CXX_x86_64_pc_windows_msvc = $tools['cl.exe']
$env:AR_x86_64_pc_windows_msvc = $tools['lib.exe']
$rustupPath = 'C:\Users\runneradmin\.cargo\bin\rustup.exe'
$rustup = [ordered]@{ present = (Test-Path -LiteralPath $rustupPath -PathType Leaf); executed = $false; addedToPath = $false }
if ($rustup.present) {
    $file = Get-Item -LiteralPath $rustupPath
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Rustup metadata reparse point.' }
    $rustup['bytes'] = $file.Length
    $rustup['sha256'] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $rustup['productVersion'] = $file.VersionInfo.ProductVersion
    $rustup['fileVersion'] = $file.VersionInfo.FileVersion
}
$exported = @{}
foreach ($name in @('PATH', 'INCLUDE', 'LIB', 'LIBPATH', 'RC', 'RC_x86_64_pc_windows_msvc', 'CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_LINKER', 'CC_x86_64_pc_windows_msvc', 'CXX_x86_64_pc_windows_msvc', 'AR_x86_64_pc_windows_msvc')) {
    $exported[$name] = [string][Environment]::GetEnvironmentVariable($name)
}
$state = [ordered]@{ compilerFilesVerified = $pins.Count; compilerFilesStaged = $tools.Count; sdkFilesVerified = 3; compilerVersion = $review.compilerVersion; sdkVersion = $runtimeReview.sdkVersion; nativeProgramsExecuted = $false; rustupMetadata = $rustup; environment = $exported }
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($StateFile, ($state | ConvertTo-Json -Depth 6 -Compress), $utf8)
