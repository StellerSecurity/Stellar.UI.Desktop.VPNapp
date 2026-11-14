# Read fixed, exact-hash SDK files as bytes. Never load or execute either file.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-PeImports([byte[]] $Data) {
    function Require-Range([long] $Offset, [long] $Length) {
        if ($Offset -lt 0 -or $Length -lt 0 -or $Offset + $Length -gt $Data.LongLength) { throw 'PE range exceeds file.' }
    }
    function U16([long] $Offset) { Require-Range $Offset 2; return [BitConverter]::ToUInt16($Data, [int] $Offset) }
    function U32([long] $Offset) { Require-Range $Offset 4; return [BitConverter]::ToUInt32($Data, [int] $Offset) }
    function CString([long] $Offset) {
        $text = New-Object Text.StringBuilder
        for ($i = 0; $i -lt 512; $i++) {
            Require-Range ($Offset + $i) 1
            $value = $Data[$Offset + $i]
            if ($value -eq 0) { return $text.ToString() }
            if ($value -lt 32 -or $value -gt 126) { throw 'Non-ASCII PE import name.' }
            [void] $text.Append([char] $value)
        }
        throw 'PE import name exceeds bound.'
    }
    if ($Data.LongLength -gt 16MB -or $Data.LongLength -lt 64 -or (U16 0) -ne 0x5a4d) { throw 'Invalid bounded MZ file.' }
    $pe = [long] (U32 60)
    Require-Range $pe 24
    if ((U32 $pe) -ne 0x4550 -or (U16 ($pe + 4)) -ne 0x8664) { throw 'Expected x64 PE.' }
    $count = U16 ($pe + 6)
    $optionalSize = U16 ($pe + 20)
    $optional = $pe + 24
    if ($count -lt 1 -or $count -gt 32 -or $optionalSize -lt 240) { throw 'Unexpected PE headers.' }
    Require-Range $optional $optionalSize
    if ((U16 $optional) -ne 0x20b -or (U32 ($optional + 108)) -lt 16) { throw 'Expected PE32+ directories.' }
    $sections = @()
    $table = $optional + $optionalSize
    Require-Range $table ($count * 40)
    for ($i = 0; $i -lt $count; $i++) {
        $at = $table + $i * 40
        $size = [long] (U32 ($at + 16))
        $pointer = [long] (U32 ($at + 20))
        Require-Range $pointer $size
        $sections += [pscustomobject]@{ rva = [long] (U32 ($at + 12)); size = $size; pointer = $pointer }
    }
    function Resolve([long] $Rva, [long] $Length) {
        $sectionsForRva = @($sections | Where-Object { $Rva -ge $_.rva -and $Rva + $Length -le $_.rva + $_.size })
        if ($sectionsForRva.Count -ne 1) { throw 'Ambiguous or unbacked PE RVA.' }
        return $sectionsForRva[0].pointer + $Rva - $sectionsForRva[0].rva
    }
    $importRva = [long] (U32 ($optional + 120))
    $importSize = [long] (U32 ($optional + 124))
    if ($importRva -eq 0 -or $importSize -lt 20 -or $importSize -gt 65536) { throw 'Expected bounded PE import directory.' }
    $start = Resolve $importRva $importSize
    $imports = @()
    $terminated = $false
    for ($i = 0; $i -lt [Math]::Min(128, [Math]::Floor($importSize / 20)); $i++) {
        $at = $start + $i * 20
        $fields = @(0, 4, 8, 12, 16 | ForEach-Object { U32 ($at + $_) })
        if (@($fields | Where-Object { $_ -ne 0 }).Count -eq 0) { $terminated = $true; break }
        $dll = CString (Resolve $fields[3] 1)
        $thunkRva = [long] $fields[0]
        if ($thunkRva -eq 0) { $thunkRva = [long] $fields[4] }
        $functions = @()
        $thunksTerminated = $false
        for ($j = 0; $j -lt 8192; $j++) {
            $thunk = Resolve ($thunkRva + $j * 8) 8
            $low = U32 $thunk
            $high = U32 ($thunk + 4)
            if ($low -eq 0 -and $high -eq 0) { $thunksTerminated = $true; break }
            if ($high -eq [uint32]2147483648 -and $low -le 65535) { $functions += ('ordinal:' + $low) }
            elseif ($high -eq 0) { $functions += CString (Resolve ([long] $low + 2) 1) }
            else { throw 'Unexpected PE import thunk.' }
        }
        if (-not $thunksTerminated) { throw 'PE import thunk bound exceeded.' }
        $imports += [ordered]@{ library = $dll; functions = $functions }
    }
    if (-not $terminated) { throw 'PE import descriptor bound exceeded.' }
    return [ordered]@{
        machine = 'x64'; imports = $imports
        # Report these directories explicitly; ordinary imports are not a
        # complete disassembly or a review of delayed/runtime-loaded code.
        delayImportRva = U32 ($optional + 112 + 13 * 8)
        delayImportSize = U32 ($optional + 116 + 13 * 8)
        tlsRva = U32 ($optional + 112 + 9 * 8)
        tlsSize = U32 ($optional + 116 + 9 * 8)
    }
}

# Synthetic invalid bytes exercise the reader, never Windows' image loader.
foreach ($sample in @([byte[]]@(), [byte[]](0..63), [byte[]](77, 90))) {
    $rejected = $false
    try { Read-PeImports $sample | Out-Null } catch { $rejected = $true }
    if (-not $rejected) { throw 'Invalid PE negative control was accepted.' }
}
$pins = @(
    @{ name = 'rc.exe'; sha256 = '9e2ee68da28b3318f50a9f1008d64567a9b402bda384a007a9b71a3f16bd011b' },
    @{ name = 'rcdll.dll'; sha256 = '4452fa0b470749e6fd70ed2ed2ac859fc243fbe4b67e6875250cfaec64f4388a' }
)
$directory = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin\10.0.26100.0\x64'
$rows = @()
foreach ($pin in $pins) {
    $file = Get-Item -LiteralPath (Join-Path $directory $pin.name)
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $file.Length -gt 16MB) { throw 'Unexpected SDK file.' }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($hash -ne $pin.sha256 -or $file.VersionInfo.ProductVersion -ne '10.0.26100.9457') { throw 'SDK review bytes changed.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -ne 'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US') { throw 'Valid Microsoft SDK signature required.' }
    $rows += [ordered]@{ name = $pin.name; sha256 = $hash; version = $file.VersionInfo.ProductVersion; signer = $signature.SignerCertificate.Subject; pe = Read-PeImports $bytes }
}
$dependencyCandidates = @()
# Inspect only the dependency named by the pinned rcdll import table, at its
# two explicit candidate locations. Do not load it or search user directories.
foreach ($candidate in @((Join-Path $directory 'ServicingCommon.dll'), (Join-Path $env:WINDIR 'System32\ServicingCommon.dll'))) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        $dependencyCandidates += [ordered]@{ path = $candidate; found = $false }
        continue
    }
    $file = Get-Item -LiteralPath $candidate
    if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $file.Length -gt 16MB) { throw 'Unexpected dependency file.' }
    $bytes = [IO.File]::ReadAllBytes($file.FullName)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    $signer = $null
    if ($null -ne $signature.SignerCertificate) { $signer = $signature.SignerCertificate.Subject }
    $dependencyCandidates += [ordered]@{
        path = $candidate; found = $true; sha256 = $hash; version = $file.VersionInfo.ProductVersion
        signatureStatus = $signature.Status.ToString(); signer = $signer; pe = Read-PeImports $bytes
    }
}
Write-Output ('STELLAR_SDK_STATIC_REVIEW=' + (ConvertTo-Json -Depth 12 -Compress -InputObject ([ordered]@{
    schema = 1; executionApproved = $false; binariesExecuted = $false; files = $rows
    dependencyCandidates = $dependencyCandidates
    limitations = 'Imports and directory metadata only; not full proprietary source review, disassembly, runtime behavior approval or approval to change build pins.'
})))
