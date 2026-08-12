param(
  [string]$WorkspaceRoot = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [switch]$Windows,
  [switch]$LinuxArm64
)

$ErrorActionPreference = "Stop"

function Copy-SdkDirectory {
  param(
    [string]$Source,
    [string]$Target
  )

  if (-not (Test-Path -LiteralPath $Source)) {
    throw "SDK source not found: $Source"
  }

  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }
  Write-Host "Prepared SDK: $Target"
}

function Find-WindowsSdkDir {
  param([string]$Root)

  $sdkRoot = Get-ChildItem -LiteralPath $Root -Directory -Filter "HCNetSDK*Win64*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sdkRoot) {
    return ""
  }
  $sdkDll = Get-ChildItem -LiteralPath $sdkRoot.FullName -Recurse -File -Filter "HCNetSDK.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sdkDll) {
    return ""
  }
  return $sdkDll.Directory.FullName
}

$projectRoot = Resolve-Path "$PSScriptRoot\..\.."
$prepareAll = -not $Windows -and -not $LinuxArm64

if ($prepareAll -or $Windows) {
  $winSource = Find-WindowsSdkDir -Root $WorkspaceRoot
  if (-not $winSource) {
    throw "Win64 HCNetSDK.dll not found under $WorkspaceRoot"
  }
  Copy-SdkDirectory `
    -Source $winSource `
    -Target (Join-Path $projectRoot "vendor\hikvision\win-x64")
}

if ($prepareAll -or $LinuxArm64) {
  Copy-SdkDirectory `
    -Source (Join-Path $WorkspaceRoot "HCNetSDKV6.1.11.5_build20251204_ArmLinux64_ZH\MakeAll") `
    -Target (Join-Path $projectRoot "vendor\hikvision\linux-arm64")
}
