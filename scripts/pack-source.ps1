# Pack the court source package for LitePaaS.
# Usage: .\scripts\pack-source.bat or .\scripts\pack-source.ps1
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $Root

$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$OutDir = Join-Path $Root 'dist'
$Name = "basketball-tactics-source_$Stamp"
$Stage = Join-Path $env:TEMP $Name
$TarGz = Join-Path $OutDir "$Name.tar.gz"
$Zip = Join-Path $OutDir "$Name.zip"

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (Test-Path -LiteralPath $Stage) { Remove-Item -LiteralPath $Stage -Recurse -Force }
New-Item -ItemType Directory -Path $Stage | Out-Null

$files = @(
  'app.js', 'index.html', 'styles.css', 'server.js', 'schema.sql',
  'package.json', 'Dockerfile', '.dockerignore', 'paas.json', '.env.example', 'README.md'
)
foreach ($item in $files) {
  $source = Join-Path $Root $item
  if (-not (Test-Path -LiteralPath $source)) { throw "missing $item" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $Stage $item) -Force
}

if (Test-Path -LiteralPath $TarGz) { Remove-Item -LiteralPath $TarGz -Force }
if (Test-Path -LiteralPath $Zip) { Remove-Item -LiteralPath $Zip -Force }

Push-Location -LiteralPath $Stage
try {
  & tar -czf $TarGz *
  if ($LASTEXITCODE -ne 0) { throw 'tar.gz failed' }
} finally {
  Pop-Location
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipFile = [System.IO.Compression.ZipFile]::Open($Zip, 'Create')
try {
  Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($Stage.Length).TrimStart('\', '/').Replace('\', '/')
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zipFile, $_.FullName, $relative)
  }
} finally {
  $zipFile.Dispose()
}
Remove-Item -LiteralPath $Stage -Recurse -Force

Write-Host 'DONE'
Write-Host "UPLOAD_THIS: $TarGz"
Write-Host "UPLOAD_ALT: $Zip"
