$ErrorActionPreference = "Stop"

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$tauriDir = Join-Path $root "src-tauri"
$targetHelperExe = Join-Path $tauriDir "target\windows-helper-dev-build\debug\stellar-vpn-helper-windows.exe"
$bundledHelperDir = Join-Path $tauriDir "bin"
$bundledHelperExe = Join-Path $bundledHelperDir "stellar-vpn-helper-windows.exe"
$openVpnPath = "C:\Program Files\OpenVPN\bin\openvpn.exe"
$msiPath = Join-Path $tauriDir "external\windows\OpenVPN-2.7.4-I001-amd64.msi"
$serviceName = "StellarVpnHelper"
$logDir = Join-Path $root "target\stellar-vpn-windows-dev"
$devServiceDir = Join-Path $logDir "service"
$devServiceExe = Join-Path $devServiceDir "stellar-vpn-helper-windows.exe"
$elevatedLog = Join-Path $logDir "helper-setup-elevated.log"

function Test-IsAdmin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Invoke-Sc {
    param([string[]]$Arguments)

    $output = & sc.exe @Arguments 2>&1
    $code = $LASTEXITCODE

    if ($output) {
        $output | ForEach-Object {
            "[sc.exe] $_" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        }
    }

    return [int]$code
}

function Install-HelperAndEngine {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null

    "[Stellar VPN] Elevated helper setup started: $(Get-Date -Format o)" | Out-File -FilePath $elevatedLog -Encoding UTF8
    "[Stellar VPN] Bundled helper exe: $bundledHelperExe" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    "[Stellar VPN] Service helper exe: $devServiceExe" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    "[Stellar VPN] OpenVPN MSI: $msiPath" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8

    if (!(Test-Path $bundledHelperExe)) {
        "[Stellar VPN] Helper binary missing: $bundledHelperExe" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        exit 10
    }

    if (!(Test-Path $openVpnPath)) {
        if (!(Test-Path $msiPath)) {
            "[Stellar VPN] Missing bundled OpenVPN MSI: $msiPath" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
            exit 11
        }

        "[Stellar VPN] Installing OpenVPN engine..." | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        $openVpnInstall = Start-Process `
            -FilePath "msiexec.exe" `
            -ArgumentList "/i `"$msiPath`" /qn /norestart" `
            -Wait `
            -PassThru

        "[Stellar VPN] OpenVPN installer exit code: $($openVpnInstall.ExitCode)" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        if ($openVpnInstall.ExitCode -ne 0) {
            exit $openVpnInstall.ExitCode
        }
    }

    if (!(Test-Path $openVpnPath)) {
        "[Stellar VPN] OpenVPN installation finished, but openvpn.exe was not found." | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        exit 12
    }

    "[Stellar VPN] Removing existing helper service if present..." | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    $queryCode = Invoke-Sc -Arguments @("query", $serviceName)
    if ($queryCode -eq 0) {
        Invoke-Sc -Arguments @("stop", $serviceName) | Out-Null
        Start-Sleep -Seconds 2
        $deleteCode = Invoke-Sc -Arguments @("delete", $serviceName)
        "[Stellar VPN] sc delete exit code: $deleteCode" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
        Start-Sleep -Seconds 2
    }

    New-Item -ItemType Directory -Force -Path $devServiceDir | Out-Null
    Copy-Item -Force $bundledHelperExe $devServiceExe
    "[Stellar VPN] Copied helper service binary: $devServiceExe" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8

    "[Stellar VPN] Creating helper service..." | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    $createCode = Invoke-Sc -Arguments @(
        "create",
        $serviceName,
        "binPath=",
        "`"$devServiceExe`"",
        "start=",
        "auto",
        "DisplayName=",
        "Stellar VPN Helper"
    )
    "[Stellar VPN] sc create exit code: $createCode" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    if ($createCode -ne 0) {
        exit 13
    }

    Invoke-Sc -Arguments @("description", $serviceName, "Privileged helper service for Stellar VPN Windows connections.") | Out-Null

    "[Stellar VPN] Starting helper service..." | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    $startCode = Invoke-Sc -Arguments @("start", $serviceName)
    "[Stellar VPN] sc start exit code: $startCode" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    if ($startCode -ne 0) {
        exit 14
    }

    "[Stellar VPN] Elevated helper setup completed: $(Get-Date -Format o)" | Out-File -FilePath $elevatedLog -Append -Encoding UTF8
    exit 0
}

if (Test-IsAdmin) {
    Install-HelperAndEngine
}

Write-Host "[Stellar VPN] Preparing Windows helper resource..."
New-Item -ItemType Directory -Force -Path $bundledHelperDir | Out-Null
if (!(Test-Path $bundledHelperExe)) {
    New-Item -ItemType File -Force -Path $bundledHelperExe | Out-Null
}

Write-Host "[Stellar VPN] Building Windows helper service..."
Push-Location $tauriDir
try {
    cargo build --target-dir target\windows-helper-dev-build --bin stellar-vpn-helper-windows
}
finally {
    Pop-Location
}

if (!(Test-Path $targetHelperExe)) {
    Write-Error "[Stellar VPN] Helper binary was not built: $targetHelperExe"
    exit 1
}

Copy-Item -Force $targetHelperExe $bundledHelperExe
Write-Host "[Stellar VPN] Bundled Windows helper: $bundledHelperExe"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Remove-Item -Force -ErrorAction SilentlyContinue $elevatedLog

Write-Host "[Stellar VPN] Requesting administrator permission for Windows helper setup..."
$args = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", "`"$PSCommandPath`""
)
$process = Start-Process -FilePath "powershell.exe" -ArgumentList $args -Verb RunAs -Wait -PassThru
if ($process.ExitCode -ne 0) {
    if (Test-Path $elevatedLog) {
        Write-Host ""
        Write-Host "[Stellar VPN] Elevated setup log:"
        Get-Content $elevatedLog | ForEach-Object { Write-Host $_ }
        Write-Host ""
    }
    Write-Error "[Stellar VPN] Windows helper setup failed or was cancelled. Exit code: $($process.ExitCode)"
    exit $process.ExitCode
}

if (Test-Path $elevatedLog) {
    Get-Content $elevatedLog | ForEach-Object { Write-Host $_ }
}

Write-Host "[Stellar VPN] Windows helper service is ready."
exit 0
