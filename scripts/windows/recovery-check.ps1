param(
  [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Copy-UpdateContent {
  param(
    [string]$SourceRoot,
    [string]$TargetRoot
  )
  $preserve = @("config", "data", "logs", "runtime")
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    if ($preserve -contains $_.Name) {
      return
    }
    $target = Join-Path $TargetRoot $_.Name
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
  }
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

$statePath = Join-Path $InstallRoot ".update\update-state.json"
$state = Read-JsonFile -Path $statePath
if (-not $state) {
  exit 0
}

$status = [string]$state.status
if ($status -in @("done", "rolled-back")) {
  exit 0
}

$backupPath = [string]$state.backupPath
if (-not $backupPath -or -not (Test-Path -LiteralPath $backupPath)) {
  Write-Host "Found unfinished update, but backup is missing. Please check manually: $statePath"
  exit 1
}

Write-Host "Found unfinished update status=$status. Restoring backup: $backupPath"
Copy-UpdateContent -SourceRoot $backupPath -TargetRoot $InstallRoot
@{
  status = "rolled-back"
  backupPath = $backupPath
  rolledBackAt = (Get-Date).ToString("s")
  reason = "startup recovery"
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
Write-Host "Startup recovery completed."
