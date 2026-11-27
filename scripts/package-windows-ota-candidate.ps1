# Packages the already-reviewed Windows release input with the NSIS 3.10
# preinstalled on Azure's windows-2022 image. No downloads or installs.
param(
    [Parameter(Mandatory = $true)][string] $InputDirectory,
    [Parameter(Mandatory = $true)][string] $OutputDirectory,
    [Parameter(Mandatory = $true)][string] $SourceCommit
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($env:TF_BUILD -ne 'True' -or $env:BUILD_REPOSITORY_NAME -cne 'StellerSecurity/Stellar.UI.Desktop.VPNapp') {
    throw 'This release packager may run only in the recorded Azure pipeline.'
}
if ($SourceCommit -notmatch '^[a-f0-9]{40}$' -or $env:BUILD_SOURCEVERSION -cne $SourceCommit) {
    throw 'Exact Azure source commit required.'
}
foreach ($path in @($InputDirectory, $OutputDirectory)) {
    if (-not [IO.Path]::IsPathRooted($path)) { throw 'Absolute staging paths required.' }
}
if (-not (Test-Path -LiteralPath $InputDirectory -PathType Container) -or (Test-Path -LiteralPath $OutputDirectory)) {
    throw 'Existing input and fresh output directories required.'
}

$input = Get-Item -LiteralPath $InputDirectory
if ($input.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Input reparse points are rejected.' }
$expectedRoot = @('build-info.json', 'Stellar VPN.exe', 'stellar-vpn-service.exe', 'Runtime')
$actualRoot = @(Get-ChildItem -LiteralPath $input.FullName | ForEach-Object Name | Sort-Object)
if (($actualRoot -join "`n") -cne (($expectedRoot | Sort-Object) -join "`n")) { throw 'Unexpected Windows signing-input contents.' }

$proof = Get-Content -LiteralPath (Join-Path $input.FullName 'build-info.json') -Raw | ConvertFrom-Json
if ($proof.schema -ne 1 -or $proof.sourceCommit -cne $SourceCommit -or $proof.architecture -cne 'x86_64' -or
    $proof.kind -cne 'windows-release-signing-input' -or $proof.signed -ne $false -or
    $proof.installerIncluded -ne $false -or $proof.binariesExecuted -ne $false -or
    $proof.runtimeExecuted -ne $false -or $proof.driverInstalled -ne $false) {
    throw 'Windows signing-input proof is invalid.'
}

$app = Join-Path $input.FullName 'Stellar VPN.exe'
$helper = Join-Path $input.FullName 'stellar-vpn-service.exe'
$runtime = Join-Path $input.FullName 'Runtime'
$manifest = Join-Path $runtime 'runtime.sha256'
if ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLowerInvariant() -cne $proof.appSha256 -or
    (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant() -cne $proof.helperSha256 -or
    (Get-FileHash -LiteralPath $manifest -Algorithm SHA256).Hash.ToLowerInvariant() -cne $proof.runtimeManifestSha256) {
    throw 'Windows signing-input hashes changed.'
}
foreach ($file in Get-ChildItem -LiteralPath $input.FullName -File -Recurse) {
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Input reparse points are rejected.' }
}
$manifestEntries = @{}
foreach ($line in Get-Content -LiteralPath $manifest) {
    if ($line -notmatch '^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$') { throw 'Invalid runtime manifest entry.' }
    if ($matches[2] -ceq 'runtime.sha256' -or $manifestEntries.ContainsKey($matches[2])) { throw 'Duplicate runtime manifest entry.' }
    $manifestEntries[$matches[2]] = $matches[1]
}
$runtimeFiles = @(Get-ChildItem -LiteralPath $runtime -File | Where-Object Name -cne 'runtime.sha256')
if ($runtimeFiles.Count -ne $manifestEntries.Count) { throw 'Runtime manifest/file count mismatch.' }
foreach ($file in $runtimeFiles) {
    if (-not $manifestEntries.ContainsKey($file.Name) -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $manifestEntries[$file.Name]) {
        throw ('Runtime hash mismatch: ' + $file.Name)
    }
}

$nsisCandidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
    (Join-Path $env:ProgramFiles 'NSIS\makensis.exe')
)
$nsis = $nsisCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if ([string]::IsNullOrEmpty($nsis)) { throw 'Preinstalled NSIS was not found; downloads are forbidden.' }
$nsisFile = Get-Item -LiteralPath $nsis
if ($nsisFile.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'NSIS reparse points are rejected.' }
$nsisVersion = ((& $nsisFile.FullName /VERSION) | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $nsisVersion -notmatch '^v?3\.10(?:\D|$)') {
    throw ('Only preinstalled NSIS 3.10 is approved, found: ' + $nsisVersion)
}
$nsisSha256 = (Get-FileHash -LiteralPath $nsisFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()

[IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
$output = Join-Path $OutputDirectory 'Stellar-VPN-setup.exe'
$script = Join-Path $PSScriptRoot '..\native\windows\installer-release.nsi'
$hooks = Join-Path $PSScriptRoot '..\native\windows\installer.nsh'
$icon = Join-Path $PSScriptRoot '..\src-tauri\icons\icon.ico'
& $nsisFile.FullName "/DSTELLAR_STAGE=$($input.FullName)" "/DSTELLAR_OUTPUT=$output" "/DSTELLAR_HOOKS=$hooks" "/DSTELLAR_ICON=$icon" $script
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $output -PathType Leaf)) { throw 'NSIS installer packaging failed.' }
if ((Get-AuthenticodeSignature -LiteralPath $output).Status -ne 'NotSigned') { throw 'Azure must emit an unsigned Authenticode candidate.' }

$result = [ordered]@{
    schema = 1
    sourceCommit = $SourceCommit
    version = '0.5.4'
    architecture = 'x86_64'
    kind = 'windows-ota-installer-signing-input'
    fileName = 'Stellar-VPN-setup.exe'
    sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
    nsisVersion = $nsisVersion
    nsisSha256 = $nsisSha256
    authenticodeSigned = $false
    otaSigned = $false
    containsReviewedRuntime = $true
    runtimeManifestSha256 = $proof.runtimeManifestSha256
    nextStep = 'Authenticode-sign the installer, then create and verify its OTA detached signature before publishing.'
}
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'windows-installer-build-info.json'), ($result | ConvertTo-Json), $utf8)
$result | ConvertTo-Json -Compress
