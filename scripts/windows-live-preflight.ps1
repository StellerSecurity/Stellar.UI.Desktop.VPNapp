# Read-only capability inventory. This is NOT a VPN/leak acceptance test.
# No credentials, network probes, adapter changes, suspend or service setup.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$os = Get-CimInstance -ClassName Win32_OperatingSystem
$computer = Get-CimInstance -ClassName Win32_ComputerSystem
$adapters = @(Get-NetAdapter -IncludeHidden)
$active = @($adapters | Where-Object { $_.Status -eq 'Up' })
$wifi = @($adapters | Where-Object { $_.InterfaceType -eq 71 -and $_.HardwareInterface -and -not $_.Virtual })
$ipv6 = @(Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue | Where-Object {
    $_.AddressState -eq 'Preferred' -and $_.IPAddress -ne '::1' -and $_.IPAddress -notmatch '^(?i:fe[89ab])'
})
$powercfg = Join-Path ([Environment]::SystemDirectory) 'powercfg.exe'
$signature = Get-AuthenticodeSignature -LiteralPath $powercfg
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft') { throw 'System power capability reader not verified.' }
$priorErrorPreference = $ErrorActionPreference
try {
    # Windows VMs can emit a diagnostic on stderr even for this read-only query.
    # Record it as unavailable/unknown rather than losing the whole inventory.
    $ErrorActionPreference = 'Continue'
    $power = (& $powercfg '/a' 2>&1 | Out-String).Trim()
    $powerExitCode = $LASTEXITCODE
} finally { $ErrorActionPreference = $priorErrorPreference }
# Hosted Windows images use English. Unknown output must not imply support.
$available = ($power -split 'The following sleep states are not available on this system:', 2)[0]
$sleep = $powerExitCode -eq 0 -and $available -match '(?m)^\s*Standby \((S3|S0 Low Power Idle)\)'
$service = Get-Service -Name 'StellarVPNDesktop' -ErrorAction SilentlyContinue
$root = Join-Path $env:ProgramFiles 'Stellar VPN'
$runtimeManifest = Test-Path -LiteralPath (Join-Path $root 'Runtime\runtime.sha256') -PathType Leaf
$helper = Test-Path -LiteralPath (Join-Path $root 'stellar-vpn-service.exe') -PathType Leaf
$blockers = @()
if ($os.ProductType -ne 1) { $blockers += 'Server OS is not Windows 10/11 desktop acceptance.' }
if ($powerExitCode -ne 0) { $blockers += 'Power capability query failed; sleep support is unverified.' }
if (-not $sleep) { $blockers += 'S3/Modern Standby unavailable: real sleep/resume cannot be tested here.' }
if ($wifi.Count -eq 0) { $blockers += 'No physical Wi-Fi interface: real Wi-Fi switching/roaming cannot be tested here.' }
if ($active.Count -lt 2) { $blockers += 'Fewer than two active interfaces: independent network handover is not available.' }
if ($ipv6.Count -eq 0) { $blockers += 'No preferred non-link-local IPv6 address: a failed IPv6 probe would not prove leak protection.' }
if ($null -eq $service -or -not $helper -or -not $runtimeManifest) { $blockers += 'Signed Stellar helper and reviewed runtime are not installed; live tunnel and kill-switch tests cannot start.' }
[ordered]@{
    schema = 1
    suite = 'windows-live-environment-preflight'
    sourceCommit = $env:SOURCE_COMMIT
    operatingSystem = $os.Caption
    build = $os.BuildNumber
    workstation = ($os.ProductType -eq 1)
    manufacturer = $computer.Manufacturer
    model = $computer.Model
    sleepAvailable = $sleep
    powerQueryExitCode = $powerExitCode
    powerCapabilities = $power
    adapterCount = $adapters.Count
    activeAdapterCount = $active.Count
    physicalWifiCount = $wifi.Count
    hasNonLinkLocalIPv6Address = ($ipv6.Count -gt 0)
    ipv6InternetReachabilityTested = $false
    helperPresent = $helper
    runtimeManifestPresent = $runtimeManifest
    stellarServicePresent = ($null -ne $service)
    blockers = $blockers
    vpnLiveTest = 'not-run'
    killSwitchLiveTest = 'not-run'
    dnsLeakTest = 'not-run'
    ipv4LeakTest = 'not-run'
    ipv6LeakTest = 'not-run'
    sleepResumeTest = 'not-run'
    networkHandoverTest = 'not-run'
    networkChanged = $false
    softwareInstalled = $false
    releaseApproved = $false
} | ConvertTo-Json -Depth 4 -Compress
