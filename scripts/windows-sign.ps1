param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$ToolDirectory,
    [Parameter(Mandatory = $true)][string]$ApprovalFile
)
# No downloads, installation, permission changes, credential reads or publication.
# The separately reviewed tool bundle must contain all its runtime dependencies.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -eq 'true' -or $env:TF_BUILD -eq 'True' -or $env:CI -eq 'true') {
    throw 'Signing is local-only. Hosted CI signing is prohibited.'
}
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows signing is required.' }
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$metadata = Join-Path $root 'native/windows/signing-metadata.json'
$approval = Get-Content -LiteralPath $ApprovalFile -Raw | ConvertFrom-Json
if ($approval.schema -ne 1 -or $approval.approved -ne $true -or $approval.scope -ne 'windows-artifact-signing') {
    throw 'Explicit approval of the exact reviewed signing tool bundle is required.'
}
if ((Get-FileHash -LiteralPath $metadata -Algorithm SHA256).Hash.ToLowerInvariant() -cne $approval.metadataSha256) {
    throw 'Signing account/profile differs from the reviewed configuration.'
}
$bundle = (Get-Item -LiteralPath $ToolDirectory).FullName
if ((Get-Item -LiteralPath $bundle).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Tool links are not allowed.' }
$files = @(Get-ChildItem -LiteralPath $bundle -Recurse -Force)
if (@($files | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'Tool links are not allowed.' }
$files = @($files | Where-Object { -not $_.PSIsContainer })
if ($files.Count -ne @($approval.files).Count) { throw 'Signing tool bundle contains missing or additional files.' }
foreach ($file in $files) {
    $relative = $file.FullName.Substring($bundle.Length + 1).Replace('\', '/')
    $entries = @($approval.files | Where-Object { $_.path -ceq $relative })
    if ($entries.Count -ne 1 -or $entries[0].sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entries[0].sha256) {
        throw 'Signing tool bundle hash mismatch.'
    }
}
# Fixed names avoid executing arbitrary commands from the approval document.
$signTool = Join-Path $bundle 'signtool.exe'
$dlib = Join-Path $bundle 'Azure.CodeSigning.Dlib.dll'
foreach ($tool in @($signTool, $dlib)) {
    $signature = Get-AuthenticodeSignature -LiteralPath $tool
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Microsoft Corporation') {
        throw 'A valid Microsoft signature is required on the signing tools.'
    }
}
$artifact = Get-Item -LiteralPath $FilePath
if ($artifact.PSIsContainer -or $artifact.Extension -notin @('.exe', '.dll', '.msi') -or
    ($artifact.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'An explicit regular Windows artifact is required.' }
$before = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
& $signTool sign /fd SHA256 /tr 'https://timestamp.acs.microsoft.com' /td SHA256 /dlib $dlib /dmdf $metadata $artifact.FullName
if ($LASTEXITCODE -ne 0) { throw 'Azure Artifact Signing failed.' }
& $signTool verify /pa /all /tw $artifact.FullName
if ($LASTEXITCODE -ne 0) { throw 'Signed artifact verification failed.' }
$signed = Get-AuthenticodeSignature -LiteralPath $artifact.FullName
if ($signed.Status -ne 'Valid' -or $null -eq $signed.TimeStamperCertificate -or
    $signed.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false) -cne 'Stellar Technology SA') {
    throw 'A trusted, timestamped Stellar Technology SA signature is required.'
}
[ordered]@{
    schema = 1
    file = $artifact.Name
    unsignedSha256 = $before
    signedSha256 = (Get-FileHash -LiteralPath $artifact.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    publisher = 'Stellar Technology SA'
    certificateThumbprint = $signed.SignerCertificate.Thumbprint
    profile = 'stellar-vpn-windows'
    timestampVerified = $true
} | ConvertTo-Json
