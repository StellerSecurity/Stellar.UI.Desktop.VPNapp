# First-party native compilation only. No installs, downloads, tool discovery,
# service/driver registration, signing, packaging, or executable smoke tests.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Native Windows required.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$approvalPath = Join-Path $root '.security-review\windows-native-compile-approval.json'
if (-not (Test-Path -LiteralPath $approvalPath -PathType Leaf)) { throw 'Explicit reviewed toolchain execution approval is missing.' }
$review = Get-Content -LiteralPath $approvalPath -Raw | ConvertFrom-Json
if ($review.approved -ne $true -or $review.scope -ne 'native-cpp-compile-only' -or
    $review.compilerVersion -ne '14.44.35229.0' -or $review.sdkDirectory -ne '10.0.26100.0') {
    throw 'This exact compiler/SDK pair is not approved for native compilation.'
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
$out = Join-Path $env:RUNNER_TEMP ('stellar-native-compile-' + [Guid]::NewGuid().ToString('N'))
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
$env:PATH = $stagedBin + ';' + (Join-Path $env:SystemRoot 'System32')
$env:INCLUDE = $include -join ';'
$env:LIB = $libraries -join ';'
$env:LIBPATH = ''
$env:CL = ''
$env:_CL_ = ''
$env:LINK = ''
$env:_LINK_ = ''
$native = Join-Path $root 'native\windows'
Push-Location $out
try {
    $flags = @('/nologo', '/c', '/std:c++20', '/EHsc', '/MT', '/W4', '/GS', '/sdl', '/guard:cf', '/utf-8', '/DUNICODE', '/D_UNICODE', '/D_WIN32_WINNT=0x0A00')
    $compileFailures = @()
    foreach ($source in @('bridge', 'service', 'bridge-link-test')) {
        & $tools['cl.exe'] @flags (Join-Path $native ($source + '.cpp')) ('/Fo' + (Join-Path $out ($source + '.obj')))
        if ($LASTEXITCODE -ne 0) { $compileFailures += $source }
    }
    if ($compileFailures.Count -gt 0) { throw ('Native compilation failed: ' + ($compileFailures -join ', ')) }
    & $tools['lib.exe'] '/NOLOGO' ('/OUT:' + (Join-Path $out 'stellar_windows.lib')) (Join-Path $out 'bridge.obj')
    if ($LASTEXITCODE -ne 0) { throw 'Bridge archive failed.' }
    $systemLibraries = @('advapi32.lib', 'shell32.lib', 'ole32.lib', 'wintrust.lib', 'crypt32.lib', 'ws2_32.lib', 'iphlpapi.lib', 'winhttp.lib', 'fwpuclnt.lib', 'rpcrt4.lib', 'wtsapi32.lib', 'bcrypt.lib', 'uuid.lib')
    $linkFlags = @('/NOLOGO', '/SUBSYSTEM:CONSOLE', '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA', '/GUARD:CF', '/INCREMENTAL:NO', '/MANIFEST:NO')
    & $tools['link.exe'] @linkFlags ('/OUT:' + (Join-Path $out 'stellar-vpn-service.exe')) (Join-Path $out 'service.obj') @systemLibraries
    if ($LASTEXITCODE -ne 0) { throw 'Service linking failed.' }
    & $tools['link.exe'] @linkFlags ('/OUT:' + (Join-Path $out 'bridge-link-test.exe')) (Join-Path $out 'bridge-link-test.obj') ('/WHOLEARCHIVE:' + (Join-Path $out 'stellar_windows.lib')) @systemLibraries
    if ($LASTEXITCODE -ne 0) { throw 'Bridge linking failed.' }
    foreach ($name in @('stellar-vpn-service.exe', 'stellar_windows.lib', 'bridge-link-test.exe')) {
        [ordered]@{ artifact = $name; sha256 = (Get-FileHash -LiteralPath (Join-Path $out $name) -Algorithm SHA256).Hash.ToLowerInvariant(); executed = $false; releaseApproved = $false } | ConvertTo-Json -Compress
    }
} finally { Pop-Location }
