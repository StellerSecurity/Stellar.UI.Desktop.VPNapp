param([Parameter(Mandatory = $true)][string]$Package)
# Static inspection only. No MSI session, custom action, service or driver setup.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ((Get-FileHash -LiteralPath $Package -Algorithm SHA256).Hash.ToLowerInvariant() -ne '33104dd02c48cba172612882b1af6276422b1b4340d4c9c84dd2afb4b356fe9f') { throw 'Unapproved MSI.' }
$root = Join-Path $env:RUNNER_TEMP 'stellar-runtime-extracted-review'
if (Test-Path -LiteralPath $root) { throw 'Fresh extraction directory required.' }
[IO.Directory]::CreateDirectory($root) | Out-Null
$expand = Join-Path ([Environment]::SystemDirectory) 'expand.exe'
$sig = Get-AuthenticodeSignature -LiteralPath $expand
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft') { throw 'System cabinet reader not verified.' }
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase([string]$Package, [int]0)
$files = @{}
$extracted = @{}
try {
    $view = $database.OpenView('SELECT `File`, `FileName`, `FileSize` FROM `File`')
    $view.Execute()
    try {
        while ($null -ne ($row = $view.Fetch())) {
            try {
                $id = [string]$row.StringData(1)
                $name = ([string]$row.StringData(2) -split '\|')[-1]
                $size = [long]$row.StringData(3)
                # Display names may contain spaces (e.g. OpenVPN HOWTO.url).
                # Only the stricter File identifier is used as an output path.
                if ($files.Count -ge 4096 -or $id -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]{0,199}$' -or $name -notmatch '^[A-Za-z0-9_][A-Za-z0-9_. -]{0,199}$' -or $size -lt 0 -or $size -gt 67108864 -or $files.ContainsKey($id)) { throw 'Unsafe or oversized file metadata.' }
                $files[$id] = @{ name = $name; size = $size }
            } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($row) | Out-Null }
        }
    } finally { $view.Close(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null }
    $media = $database.OpenView('SELECT `Cabinet` FROM `Media`')
    $media.Execute()
    $cabinetCount = 0
    try {
        while ($null -ne ($row = $media.Fetch())) {
            try { $cabinet = [string]$row.StringData(1) } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($row) | Out-Null }
            if (++$cabinetCount -gt 16 -or $cabinet -notmatch '^#[A-Za-z0-9_][A-Za-z0-9_.-]{0,100}$') { throw 'Only bounded embedded cabinets accepted.' }
            $streamName = $cabinet.Substring(1)
            $stream = $database.OpenView('SELECT `Data` FROM `_Streams` WHERE `Name` = ''' + $streamName + '''')
            $stream.Execute()
            $record = $stream.Fetch()
            if ($null -eq $record) { throw 'Missing embedded cabinet.' }
            $cabPath = Join-Path $root ('cabinet-' + $cabinetCount + '.cab')
            try {
                $output = [IO.File]::Open($cabPath, [IO.FileMode]::CreateNew)
                try {
                    $total = 0
                    do {
                        $chunk = [string]$record.ReadStream(1, 65536, 1)
                        $total += $chunk.Length
                        if ($total -gt 16777216) { throw 'Oversized cabinet stream.' }
                        $bytes = New-Object byte[] $chunk.Length
                        for ($i = 0; $i -lt $chunk.Length; $i++) { $bytes[$i] = [byte][char]$chunk[$i] }
                        $output.Write($bytes, 0, $bytes.Length)
                    } while ($chunk.Length -ne 0)
                } finally { $output.Dispose() }
            } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null; $stream.Close(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($stream) | Out-Null }
            # Validate every cabinet path and declared size before the system
            # decoder sees it. No spanning cabinets, links or relative paths.
            $reader = New-Object IO.BinaryReader([IO.File]::OpenRead($cabPath))
            $ids = @()
            try {
                if ($reader.ReadUInt32() -ne 0x4643534d) { throw 'Invalid cabinet signature.' }
                $reader.BaseStream.Position = 8
                if ($reader.ReadUInt32() -ne $reader.BaseStream.Length) { throw 'Invalid cabinet size.' }
                $reader.BaseStream.Position = 16; $fileOffset = $reader.ReadUInt32()
                $reader.BaseStream.Position = 28; $count = $reader.ReadUInt16(); $flags = $reader.ReadUInt16()
                if ($flags -ne 0 -or $count -eq 0 -or $count -gt 4096 -or $fileOffset -lt 36 -or $fileOffset -ge $reader.BaseStream.Length) { throw 'Unsupported cabinet layout.' }
                $reader.BaseStream.Position = $fileOffset
                $expandedSize = 0L
                for ($index = 0; $index -lt $count; $index++) {
                    $size = $reader.ReadUInt32(); $expandedSize += $size
                    $reader.BaseStream.Position += 12
                    $id = ''
                    while (($b = $reader.ReadByte()) -ne 0) {
                        if ($id.Length -ge 200 -or $b -gt 127) { throw 'Unsafe cabinet filename.' }
                        $id += [char]$b
                    }
                    if (-not $files.ContainsKey($id) -or $extracted.ContainsKey($id) -or $ids -contains $id -or $size -ne $files[$id].size -or $expandedSize -gt 134217728) { throw 'Cabinet file does not match approved MSI metadata.' }
                    $ids += $id
                }
            } finally { $reader.Dispose() }
            $destination = Join-Path $root ('files-' + $cabinetCount)
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            & $expand '-F:*' $cabPath $destination | Out-Null
            if ($LASTEXITCODE -ne 0) { throw 'System cabinet extraction failed.' }
            $actual = @(Get-ChildItem -LiteralPath $destination -Force)
            if ($actual.Count -ne $ids.Count) { throw 'Unexpected extracted file count.' }
            foreach ($item in $actual) {
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $ids -notcontains $item.Name -or $item.Length -ne $files[$item.Name].size) { throw 'Unexpected extracted object.' }
                $metadata = $files[$item.Name]
                $reviewPath = $item.FullName
                # MSI identifiers end in a merge-module GUID, not .cat. Preserve
                # the byte hash but restore the original extension so Windows
                # selects the catalog SIP instead of the generic file SIP.
                if ($metadata.name -eq 'ovpn-dco.cat') {
                    $catalogDirectory = Join-Path $root ('catalog-' + $item.Name)
                    [IO.Directory]::CreateDirectory($catalogDirectory) | Out-Null
                    $reviewPath = Join-Path $catalogDirectory 'ovpn-dco.cat'
                    [IO.File]::Copy($item.FullName, $reviewPath, $false)
                    if ((Get-FileHash -LiteralPath $reviewPath -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash) { throw 'Catalog bytes changed during static naming.' }
                }
                $signature = Get-AuthenticodeSignature -LiteralPath $reviewPath
                $subject = $null; $thumbprint = $null
                if ($null -ne $signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject; $thumbprint = $signature.SignerCertificate.Thumbprint }
                [ordered]@{ id = $item.Name; name = $metadata.name; size = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); signature = $signature.Status.ToString(); signer = $subject; thumbprint = $thumbprint } | ConvertTo-Json -Compress
                $extracted[$item.Name] = $reviewPath
                if ($metadata.name -match '\.(inf|sha256|txt)$' -and $item.Length -le 65536) {
                    [ordered]@{ id = $item.Name; staticText = [IO.File]::ReadAllText($item.FullName) } | ConvertTo-Json -Compress
                }
            }
        }
    } finally { $media.Close(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($media) | Out-Null }
    if ($extracted.Count -ne $files.Count) { throw 'Incomplete extraction coverage.' }
    # First-party interop with the OS trust library. This opens catalog data
    # read-only, calculates Authenticode hashes and never registers a catalog.
    if ([Environment]::SystemDirectory -ne 'C:\Windows\System32') { throw 'Unexpected Windows system directory.' }
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StellarStaticCatalog {
    const string Trust = @"C:\Windows\System32\wintrust.dll";
    [DllImport(Trust, CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern bool CryptCATAdminAcquireContext2(out IntPtr context, IntPtr subsystem, string algorithm, IntPtr policy, uint flags);
    [DllImport(Trust, ExactSpelling=true, SetLastError=true)]
    static extern bool CryptCATAdminCalcHashFromFileHandle2(IntPtr context, IntPtr file, ref uint size, [Out] byte[] hash, uint flags);
    [DllImport(Trust, ExactSpelling=true)]
    static extern bool CryptCATAdminReleaseContext(IntPtr context, uint flags);
    [DllImport(Trust, CharSet=CharSet.Unicode, ExactSpelling=true, SetLastError=true)]
    static extern IntPtr CryptCATOpen(string path, uint flags, IntPtr provider, uint version, uint encoding);
    [DllImport(Trust, CharSet=CharSet.Unicode, ExactSpelling=true)]
    static extern IntPtr CryptCATGetMemberInfo(IntPtr catalog, string tag);
    [DllImport(Trust, ExactSpelling=true)]
    static extern bool CryptCATClose(IntPtr catalog);
    public static bool Contains(string catalogPath, string filePath) {
        IntPtr context;
        if (!CryptCATAdminAcquireContext2(out context, IntPtr.Zero, "SHA256", IntPtr.Zero, 0)) throw new Win32Exception();
        try {
            string tag;
            using (var file = File.OpenRead(filePath)) {
                uint size = 0;
                if (!CryptCATAdminCalcHashFromFileHandle2(context, file.SafeFileHandle.DangerousGetHandle(), ref size, null, 0) || size != 32) throw new Win32Exception();
                byte[] hash = new byte[size];
                if (!CryptCATAdminCalcHashFromFileHandle2(context, file.SafeFileHandle.DangerousGetHandle(), ref size, hash, 0)) throw new Win32Exception();
                tag = BitConverter.ToString(hash).Replace("-", "");
            }
            IntPtr catalog = CryptCATOpen(catalogPath, 4, IntPtr.Zero, 0x200, 0);
            if (catalog == IntPtr.Zero || catalog == new IntPtr(-1)) throw new Win32Exception();
            try { return CryptCATGetMemberInfo(catalog, tag) != IntPtr.Zero; }
            finally { CryptCATClose(catalog); }
        } finally { CryptCATAdminReleaseContext(context, 0); }
    }
}
'@
    $suffix = '.1057B5BE_89F7_469C_A3FD_D6662CD1D229'
    $groups = @(
        @{ catalog = 'ovpndco_nx20.cat'; members = @('ovpndco.inf', 'ovpndco_nx20.sys') },
        @{ catalog = 'ovpndco_nx21.cat'; members = @('ovpndco_nx21.inf', 'ovpndco_nx21.sys') }
    )
    foreach ($group in $groups) {
        $catId = $group.catalog + $suffix
        if (-not $extracted.ContainsKey($catId)) { throw 'Required driver catalog missing.' }
        $cat = $extracted[$catId]
        $catSignature = Get-AuthenticodeSignature -LiteralPath $cat
        if ($catSignature.Status -ne 'Valid' -or $catSignature.SignerCertificate.Subject -notmatch 'Microsoft Windows Hardware Compatibility Publisher') { throw 'Driver catalog trust not verified.' }
        foreach ($member in $group.members) {
            $memberId = $member + $suffix
            if (-not $extracted.ContainsKey($memberId) -or -not [StellarStaticCatalog]::Contains($cat, $extracted[$memberId])) { throw 'Driver file does not belong to its signed catalog.' }
            [ordered]@{ catalog = $catId; member = $memberId; sha256CatalogMember = $true; catalogSignature = 'Valid' } | ConvertTo-Json -Compress
        }
        if ([StellarStaticCatalog]::Contains($cat, $extracted['config.README.txt'])) { throw 'Catalog negative control failed.' }
    }
    [ordered]@{ review = 'static-extraction-only'; filesInspected = $extracted.Count; packageExtracted = $true; packageExecuted = $false; serviceInstalled = $false; driverInstalled = $false; catalogMembershipVerified = $true; catalogNegativeControls = 2; releaseApproved = $false } | ConvertTo-Json -Compress
} finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
}
