param(
  [string]$Version = "",
  [ValidateSet("canary", "beta", "stable")]
  [string]$Channel = "canary",
  [string]$BaseUrl = "http://www.fenqunshuju.com/releases/camera-local-console",
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"

$projectRoot = Resolve-Path "$PSScriptRoot\.."
if (-not $Version) {
  $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$packageJson.version
}

$packageName = "camera-local-console-win-x64-$Version"

$packageArgs = @{
  PackageName = $packageName
  Version = $Version
  Channel = $Channel
}
if ($NoZip) {
  $packageArgs.NoZip = $true
}

& (Join-Path $projectRoot "scripts\package-windows.ps1") @packageArgs

$distDir = Join-Path $projectRoot "dist"
$packageDir = Join-Path $distDir $packageName
$zipPath = Join-Path $distDir "$packageName.zip"

if (-not $NoZip -and -not (Test-Path -LiteralPath $zipPath)) {
  throw "Package zip not found: $zipPath"
}

$releaseDir = Join-Path $projectRoot "release\out"
$packagesDir = Join-Path $releaseDir "packages\win-x64"
$channelsDir = Join-Path $releaseDir "channels"
$manifestsDir = Join-Path $releaseDir "manifests"
New-Item -ItemType Directory -Force -Path $packagesDir,$channelsDir,$manifestsDir | Out-Null

if (-not $NoZip) {
  Copy-Item -LiteralPath $zipPath -Destination (Join-Path $packagesDir "$packageName.zip") -Force
  $sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zipPath).Hash.ToLowerInvariant()
  $manifest = [ordered]@{
    version = $Version
    channel = $Channel
    platform = "win-x64"
    url = "$BaseUrl/packages/win-x64/$packageName.zip"
    sha256 = $sha256
    required = $false
    notes = ""
  }
  $manifestPath = Join-Path $manifestsDir "$Version-win-x64.json"
  $channelPath = Join-Path $channelsDir "$Channel.json"
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $channelPath -Encoding UTF8
  Write-Host "Release generated:"
  Write-Host "  package:  $packagesDir\$packageName.zip"
  Write-Host "  manifest: $manifestPath"
  Write-Host "  channel:  $channelPath"
} else {
  Write-Host "Directory package generated:"
  Write-Host "  $packageDir"
}
