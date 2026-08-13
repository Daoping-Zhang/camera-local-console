param(
  [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = "SilentlyContinue"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path.TrimEnd("\")

function Read-ConfiguredPorts {
  param([string]$Root)
  $ports = @{
    PORT = "3000"
    COLLECTOR_PORT = "3100"
  }
  $portsFile = Join-Path $Root "config\ports.env"
  if (Test-Path -LiteralPath $portsFile) {
    foreach ($line in Get-Content -LiteralPath $portsFile) {
      if ($line -match "^\s*(PORT|COLLECTOR_PORT)\s*=\s*(\d+)\s*$") {
        $ports[$Matches[1].ToUpperInvariant()] = $Matches[2]
      }
    }
  }
  return $ports
}

function Get-ListeningPids {
  param([int]$Port)
  $ids = @()
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $ids += Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
  }
  if (-not $ids -or $ids.Count -eq 0) {
    $lines = netstat -ano -p tcp 2>$null | Select-String (":$Port\s+.*LISTENING\s+(\d+)")
    foreach ($line in $lines) {
      if ($line.Line -match "\s+(\d+)\s*$") {
        $ids += [int]$Matches[1]
      }
    }
  }
  return @($ids | Where-Object { $_ -and $_ -ne $PID } | Select-Object -Unique)
}

function Convert-Port {
  param([string]$Value)
  $parsed = 0
  if ([int]::TryParse($Value, [ref]$parsed) -and $parsed -gt 0 -and $parsed -lt 65536) {
    return $parsed
  }
  return $null
}

$ports = Read-ConfiguredPorts -Root $InstallRoot
$targetPorts = @(Convert-Port $ports.PORT; Convert-Port $ports.COLLECTOR_PORT) |
  Where-Object { $_ } |
  Select-Object -Unique
$stopped = 0

foreach ($targetPort in $targetPorts) {
  foreach ($processId in Get-ListeningPids -Port $targetPort) {
    Write-Host ("Stopping process on port {0}: {1}" -f $targetPort, $processId)
    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
    $stopped += 1
  }
}

foreach ($title in @("camera-console*", "camera-console-3000*", "camera-collector-3100*")) {
  & taskkill.exe /FI "WINDOWTITLE eq $title" /T /F 2>$null | Out-Null
}

Write-Host ("Stopped {0} process tree(s). Ports: {1}" -f $stopped, ($targetPorts -join ", "))
