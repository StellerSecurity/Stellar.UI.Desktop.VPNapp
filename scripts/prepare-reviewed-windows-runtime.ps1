# Download and statically extract one exact, previously reviewed OpenVPN package.
# The MSI, runtime and driver are never installed or executed by this script.
param([Parameter(Mandatory = $true)][string]$OutputDirectory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($OutputDirectory) -or (Test-Path -LiteralPath $OutputDirectory)) { throw 'Fresh absolute output directory required.' }
$name = 'OpenVPN-2.7.8-I002-amd64.msi'
$bytes = 5922816
$expected = '33104dd02c48cba172612882b1af6276422b1b4340d4c9c84dd2afb4b356fe9f'
$package = Join-Path $env:RUNNER_TEMP $name
if (Test-Path -LiteralPath $package) { throw 'Fresh reviewed package path required.' }
$request = [Net.HttpWebRequest]::Create('https://build.openvpn.net/downloads/releases/' + $name)
$request.AllowAutoRedirect = $false
$request.Timeout = 30000
$request.ReadWriteTimeout = 30000
$response = $request.GetResponse()
try {
    if ($response.ContentLength -ne $bytes) { throw 'Reviewed OpenVPN package size changed.' }
    $input = $response.GetResponseStream()
    $output = [IO.File]::Open($package, [IO.FileMode]::CreateNew)
    try {
        $buffer = New-Object byte[] 65536
        $remaining = $bytes
        while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $remaining -= $count
            if ($remaining -lt 0) { throw 'Reviewed package exceeded its exact size.' }
            $output.Write($buffer, 0, $count)
        }
        if ($remaining -ne 0) { throw 'Reviewed package download was truncated.' }
    } finally { $output.Dispose(); $input.Dispose() }
} finally { $response.Dispose() }
if ((Get-FileHash -LiteralPath $package -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'Reviewed OpenVPN package hash changed.' }
$signature = Get-AuthenticodeSignature -LiteralPath $package
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(^|,\s*)O=OpenVPN Inc\.(,|$)') { throw 'Reviewed OpenVPN publisher signature is invalid.' }
& (Join-Path $PSScriptRoot 'windows-runtime-extract-review.ps1') -Package $package -ExportDirectory $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw 'Reviewed OpenVPN runtime extraction failed.' }
