$ErrorActionPreference = "Stop"

$openVpnPath = "C:\Program Files\OpenVPN\bin\openvpn.exe"
$msiPath = Join-Path $PSScriptRoot "..\..\src-tauri\external\windows\OpenVPN-2.7.4-I001-amd64.msi"
$msiPath = [System.IO.Path]::GetFullPath($msiPath)

Write-Host "[Stellar VPN] Checking Windows OpenVPN engine..."

if (Test-Path $openVpnPath) {
    Write-Host "[Stellar VPN] OpenVPN engine already installed."
    exit 0
}

if (!(Test-Path $msiPath)) {
    Write-Error "[Stellar VPN] Missing bundled OpenVPN MSI: $msiPath"
    exit 1
}

Write-Host "[Stellar VPN] Installing OpenVPN engine for development..."
Write-Host "[Stellar VPN] Windows may ask for administrator permission."

$process = Start-Process `
    -FilePath "msiexec.exe" `
    -ArgumentList "/i `"$msiPath`" /qn /norestart" `
    -Verb RunAs `
    -Wait `
    -PassThru

if ($process.ExitCode -ne 0) {
    Write-Error "[Stellar VPN] OpenVPN installer failed with exit code $($process.ExitCode)."
    exit $process.ExitCode
}

if (!(Test-Path $openVpnPath)) {
    Write-Error "[Stellar VPN] OpenVPN installation finished, but openvpn.exe was not found."
    exit 1
}

Write-Host "[Stellar VPN] OpenVPN engine installed."
exit 0