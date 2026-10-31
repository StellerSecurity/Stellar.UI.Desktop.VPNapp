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
                $signature = Get-AuthenticodeSignature -LiteralPath $item.FullName
                $subject = $null; $thumbprint = $null
                if ($null -ne $signature.SignerCertificate) { $subject = $signature.SignerCertificate.Subject; $thumbprint = $signature.SignerCertificate.Thumbprint }
                [ordered]@{ id = $item.Name; name = $metadata.name; size = $item.Length; sha256 = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); signature = $signature.Status.ToString(); signer = $subject; thumbprint = $thumbprint } | ConvertTo-Json -Compress
                $extracted[$item.Name] = $item.FullName
                if ($metadata.name -match '\.(inf|sha256|txt)$' -and $item.Length -le 65536) {
                    [ordered]@{ id = $item.Name; staticText = [IO.File]::ReadAllText($item.FullName) } | ConvertTo-Json -Compress
                }
            }
        }
    } finally { $media.Close(); [Runtime.InteropServices.Marshal]::FinalReleaseComObject($media) | Out-Null }
    if ($extracted.Count -ne $files.Count) { throw 'Incomplete extraction coverage.' }
    [ordered]@{ review = 'static-extraction-only'; filesInspected = $extracted.Count; packageExtracted = $true; packageExecuted = $false; serviceInstalled = $false; driverInstalled = $false; catalogMembershipVerified = $false; releaseApproved = $false } | ConvertTo-Json -Compress
} finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
}
