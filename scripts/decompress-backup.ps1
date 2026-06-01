# Decompress the latest Paperclip backup
$backupDir = "$env:USERPROFILE\.paperclip\instances\default\data\backups"
$gzFile = Join-Path $backupDir "paperclip-20260528-212845.sql.gz"
$sqlFile = Join-Path $backupDir "migration_latest.sql"

Write-Host "Decompressing $gzFile..."

$gzStream = [System.IO.Compression.GZipStream]::new(
    [System.IO.File]::OpenRead($gzFile),
    [System.IO.Compression.CompressionMode]::Decompress
)
$outStream = [System.IO.File]::Create($sqlFile)
$gzStream.CopyTo($outStream)
$outStream.Close()
$gzStream.Close()

$size = (Get-Item $sqlFile).Length
Write-Host "Decompressed: $sqlFile ($([math]::Round($size / 1MB, 2)) MB)"
