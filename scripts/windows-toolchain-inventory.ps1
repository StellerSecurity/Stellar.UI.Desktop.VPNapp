# Read-only review input. Run in a Windows x64 Developer PowerShell shell.
# Does not execute the discovered tools, install anything, elevate, inspect
# credentials, enumerate profiles, or collect environment variables.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Run this inventory on the Windows machine intended for native testing.'
}

function Get-ToolMetadata([string] $Name, [string] $Path = '', [bool] $CheckSignature = $false) {
    if ([string]::IsNullOrEmpty($Path)) {
        $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $command) { return [ordered]@{ name = $Name; found = $false } }
        $Path = $command.Source
    }
    $file = Get-Item -LiteralPath $Path
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing a tool reparse point: $Name" }
    $signatureStatus = 'NotChecked'
    $signer = $null
    $thumbprint = $null
    if ($CheckSignature) {
        # Windows verifies the file; the discovered executable is never run.
        # Revocation/trust validation may contact certificate-authority services.
        $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
        $signatureStatus = $signature.Status.ToString()
        if ($null -ne $signature.SignerCertificate) {
            $signer = $signature.SignerCertificate.Subject
            $thumbprint = $signature.SignerCertificate.Thumbprint
        }
    }
    return [ordered]@{
        name = $Name
        found = $true
        path = $file.FullName
        fileVersion = $file.VersionInfo.FileVersion
        productVersion = $file.VersionInfo.ProductVersion
        publisherClaim = $file.VersionInfo.CompanyName
        sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        signatureVerified = ($signatureStatus -eq 'Valid')
        signatureStatus = $signatureStatus
        signer = $signer
        signerThumbprint = $thumbprint
    }
}

$tools = @('cl.exe', 'lib.exe', 'link.exe', 'rc.exe', 'signtool.exe', 'cargo.exe', 'rustc.exe', 'node.exe', 'makensis.exe') |
    ForEach-Object { Get-ToolMetadata $_ }
# The hosted runner has MSVC installed but does not initialize a Developer
# Shell. Inspect that fixed Microsoft tool directory without running vcvars,
# VsDevCmd, vswhere, cl, cargo or another executable.
$msvcRoot = Join-Path ${env:ProgramFiles} 'Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC'
$compilerComponents = @()
if (Test-Path -LiteralPath $msvcRoot) {
    $versions = @(Get-ChildItem -LiteralPath $msvcRoot -Directory |
        Where-Object { $_.Name -match '^[0-9]+\.[0-9]+\.[0-9]+$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) })
    foreach ($version in $versions) {
        foreach ($name in @('cl.exe', 'lib.exe', 'link.exe')) {
            $path = Join-Path $version.FullName ('bin\Hostx64\x64\' + $name)
            if (Test-Path -LiteralPath $path) { $tools += Get-ToolMetadata $name $path }
        }
        if ($version.Name -eq '14.44.35207') {
            $bin = Join-Path $version.FullName 'bin\Hostx64\x64'
            $files = @(Get-ChildItem -LiteralPath $bin -File |
                Where-Object { $_.Extension -in @('.exe', '.dll') })
            if ($files.Count -gt 100) { throw 'Unexpected MSVC component count; review required.' }
            foreach ($file in $files) {
                $compilerComponents += Get-ToolMetadata $file.Name $file.FullName $true
            }
        }
    }
}
$sdkVersions = @()
$sdkKey = 'HKLM:\SOFTWARE\Microsoft\Windows Kits\Installed Roots'
if (Test-Path -LiteralPath $sdkKey) {
    $installed = Get-ItemProperty -LiteralPath $sdkKey -Name KitsRoot10 -ErrorAction SilentlyContinue
    if ($null -ne $installed) {
        $include = Join-Path $installed.KitsRoot10 'Include'
        if (Test-Path -LiteralPath $include) {
            $sdkVersions = @(Get-ChildItem -LiteralPath $include -Directory |
                Where-Object { $_.Name -match '^10\.0\.[0-9]+\.[0-9]+$' -and -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) } |
                Select-Object -ExpandProperty Name)
            foreach ($version in $sdkVersions) {
                foreach ($name in @('rc.exe', 'signtool.exe')) {
                    $path = Join-Path $installed.KitsRoot10 ('bin\' + $version + '\x64\' + $name)
                    if (Test-Path -LiteralPath $path) { $tools += Get-ToolMetadata $name $path }
                }
            }
        }
    }
}

[ordered]@{
    schema = 1
    runnerImageVersion = $env:ImageVersion
    purpose = 'Unapproved metadata for exact Windows toolchain security review; not permission to execute tools'
    osVersion = [Environment]::OSVersion.Version.ToString()
    is64BitOS = [Environment]::Is64BitOperatingSystem
    is64BitProcess = [Environment]::Is64BitProcess
    sdkVersions = $sdkVersions
    tools = @($tools)
    compilerComponents = $compilerComponents
    approved = $false
} | ConvertTo-Json -Depth 6
