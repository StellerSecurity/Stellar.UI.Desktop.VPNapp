# Read-only Windows Authenticode decisions for exact staged public SDK files.
param([Parameter(Mandatory = $true)][string] $Directory)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$expected = @{
    'x86' = '161dc6673084a31f64670ace8e61cb0e1b55af815b6c7c8217a0cdd8503454e2'
    'x64' = '86545b66cdb0603bc26b626fb9ad610cb6e71f28d468f5ea66df23b03dda96d5'
    'arm64' = 'a0de1844933a10c898f833771a85f0ab9a0e3c745d4715f63d2d9730f9416025'
}
$sha = [Security.Cryptography.SHA256]::Create()
try {
    $rows = @()
    foreach ($arch in @('x86', 'x64', 'arm64')) {
        $path = Join-Path $Directory ($arch + '.dll')
        $item = Get-Item -LiteralPath $path
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Loader reparse point rejected.' }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected[$arch]) { throw 'Exact reviewed loader required.' }
        $signature = Get-AuthenticodeSignature -LiteralPath $path
        if ($null -eq $signature.SignerCertificate) { throw 'Missing public signer certificate.' }
        $certificateHash = ([BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant()
        if ($certificateHash -ne '5edd84352db3d8a11accdd6ea17483e07a61162ddecb01611632823a21923027') { throw 'Loader publisher certificate changed.' }
        $changed = Join-Path $Directory ($arch + '-changed.dll')
        $bytes = [IO.File]::ReadAllBytes($path)
        $bytes[1024] = $bytes[1024] -bxor 1
        [IO.File]::WriteAllBytes($changed, $bytes)
        $negative = Get-AuthenticodeSignature -LiteralPath $changed
        if ($negative.Status -eq 'Valid') { throw 'Changed loader inherited trusted signature.' }
        $stamp = $signature.TimeStamperCertificate
        $rows += [ordered]@{
            architecture = $arch
            fileSha256 = $expected[$arch]
            signatureStatus = [string]$signature.Status
            signatureStatusMessage = $signature.StatusMessage
            signatureType = [string]$signature.SignatureType
            signerSubject = $signature.SignerCertificate.Subject
            signerCertificateSha256 = $certificateHash
            signerNotBefore = $signature.SignerCertificate.NotBefore.ToUniversalTime().ToString('o')
            signerNotAfter = $signature.SignerCertificate.NotAfter.ToUniversalTime().ToString('o')
            timestampCertificatePresent = ($null -ne $stamp)
            timestampSubject = $(if ($null -ne $stamp) { $stamp.Subject } else { $null })
            changedByteSignatureStatus = [string]$negative.Status
            revocationIndependentlyChecked = $false
            targetExecuted = $false
            nativeCodeCleared = $false
        }
    }
    [ordered]@{ loaderTrustDecisions = $rows; nativeCodeCleared = $false; released = $false } | ConvertTo-Json -Depth 6 -Compress
} finally {
    $sha.Dispose()
}
