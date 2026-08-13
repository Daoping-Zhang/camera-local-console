param(
  [string]$ManifestUrl = "",
  [string]$Channel = "",
  [ValidateSet("Normal", "NoBrowser", "None")]
  [string]$RestartMode = "Normal",
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-ProgressEvent {
  param(
    [string]$Stage,
    [int]$Percent,
    [string]$Message
  )
  @{
    type = "progress"
    stage = $Stage
    percent = $Percent
    message = $Message
    time = (Get-Date).ToString("s")
  } | ConvertTo-Json -Compress | ForEach-Object { Write-Host "UPDATE_PROGRESS $_" }
}

function Write-UpdateState {
  param(
    [string]$StatePath,
    [hashtable]$State
  )
  $dir = Split-Path -Parent $StatePath
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $State.updatedAt = (Get-Date).ToString("s")
  $State | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $StatePath -Encoding UTF8
}

function Download-FileWithProgress {
  param(
    [string]$Url,
    [string]$OutFile
  )
  Write-ProgressEvent -Stage "download" -Percent 0 -Message "Connecting to download server..."
  $request = [System.Net.HttpWebRequest]::Create($Url)
  $request.UserAgent = "camera-local-console-updater"
  $response = $request.GetResponse()
  try {
    $total = [int64]$response.ContentLength
    $inputStream = $response.GetResponseStream()
    $outputStream = [System.IO.File]::Create($OutFile)
    try {
      $buffer = New-Object byte[] (1024 * 1024)
      $readTotal = [int64]0
      $lastPercent = -1
      while (($read = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $outputStream.Write($buffer, 0, $read)
        $readTotal += $read
        if ($total -gt 0) {
          $percent = [Math]::Min(100, [int](($readTotal * 100) / $total))
          if ($percent -ne $lastPercent) {
            Write-ProgressEvent -Stage "download" -Percent $percent -Message ("Downloading package {0}%" -f $percent)
            $lastPercent = $percent
          }
        } else {
          Write-ProgressEvent -Stage "download" -Percent 0 -Message ("Downloading package {0:n1} MB" -f ($readTotal / 1MB))
        }
      }
    } finally {
      $outputStream.Close()
      $inputStream.Close()
    }
  } finally {
    $response.Close()
  }
  Write-ProgressEvent -Stage "download" -Percent 100 -Message "Package download completed"
}

function Expand-ZipPackage {
  param(
    [string]$ZipPath,
    [string]$DestinationPath
  )
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path -LiteralPath $DestinationPath) {
      Remove-Item -LiteralPath $DestinationPath -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
    [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $DestinationPath)
  } catch {
    throw "Package extraction failed. Please confirm the downloaded file is a valid zip archive."
  }
}

function Read-ConfiguredPorts {
  param([string]$InstallRoot)
  $ports = @{
    PORT = "3000"
    COLLECTOR_PORT = "3100"
  }
  $portsFile = Join-Path $InstallRoot "config\ports.env"
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
  $pids = @()
  try {
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
      $pids += Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue
    }
  } catch {}
  if (-not $pids -or $pids.Count -eq 0) {
    try {
      $lines = netstat -ano -p tcp 2>$null | Select-String (":$Port\s+.*LISTENING\s+(\d+)")
      foreach ($line in $lines) {
        if ($line.Line -match "\s+(\d+)\s*$") {
          $pids += [int]$Matches[1]
        }
      }
    } catch {}
  }
  $runnerPid = 0
  [int]::TryParse($env:UPDATE_RUNNER_PID, [ref]$runnerPid) | Out-Null
  return @($pids | Where-Object { $_ -and $_ -ne $PID -and $_ -ne $runnerPid } | Select-Object -Unique)
}

function Stop-ProcessByPid {
  param([int]$ProcessId)
  try {
    & taskkill.exe /PID $ProcessId /F 2>$null | Out-Null
  } catch {
    try {
      Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
    } catch {}
  }
}

function Stop-CameraConsole {
  param([string]$InstallRoot)
  $ports = Read-ConfiguredPorts -InstallRoot $InstallRoot
  $targetPorts = @([int]$ports.PORT, [int]$ports.COLLECTOR_PORT) | Select-Object -Unique
  foreach ($targetPort in $targetPorts) {
    foreach ($processId in Get-ListeningPids -Port $targetPort) {
      Write-Host ("Stopping process on port {0}: {1}" -f $targetPort, $processId)
      Stop-ProcessByPid -ProcessId $processId
    }
  }
  $deadline = (Get-Date).AddSeconds(10)
  while ((Get-Date) -lt $deadline) {
    $stillListening = $false
    foreach ($targetPort in $targetPorts) {
      if ((Get-ListeningPids -Port $targetPort).Count -gt 0) {
        $stillListening = $true
      }
    }
    if (-not $stillListening) {
      return
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Host "Some previous processes may still be shutting down; continuing update."
}

function Copy-UpdateContent {
  param(
    [string]$SourceRoot,
    [string]$TargetRoot
  )

  $preserve = @("config", "data", "logs", "runtime")
  Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object {
    if ($preserve -contains $_.Name) {
      Write-Host "Preserving local directory: $($_.Name)"
      return
    }
    $target = Join-Path $TargetRoot $_.Name
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
    }
    Copy-Item -LiteralPath $_.FullName -Destination $TargetRoot -Recurse -Force
  }
}

function Sync-AutostartShortcut {
  param([string]$InstallRoot)
  $startup = [Environment]::GetFolderPath("Startup")
  $shortcut = Join-Path $startup "camera-local-console.lnk"
  if (-not (Test-Path -LiteralPath $shortcut)) {
    Write-Host "Startup auto-run is not enabled; skip shortcut sync."
    return
  }
  $target = Join-Path $InstallRoot "start-all.cmd"
  if (-not (Test-Path -LiteralPath $target)) {
    Write-Host "start-all.cmd was not found; skip shortcut sync."
    return
  }
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $link.TargetPath = $target
  $link.Arguments = "/minimized /no-browser"
  $link.WorkingDirectory = $InstallRoot
  $link.IconLocation = $target
  $link.Save()
  Write-Host "Startup auto-run shortcut synced: $shortcut"
}

function Restore-Backup {
  param(
    [string]$BackupPath,
    [string]$InstallRoot,
    [string]$StatePath = ""
  )
  if (-not (Test-Path -LiteralPath $BackupPath)) {
    throw "Backup path does not exist: $BackupPath"
  }
  Write-ProgressEvent -Stage "rollback" -Percent 0 -Message "Rolling back to previous version..."
  Stop-CameraConsole -InstallRoot $InstallRoot
  Copy-UpdateContent -SourceRoot $BackupPath -TargetRoot $InstallRoot
  if ($StatePath) {
    Write-UpdateState -StatePath $StatePath -State @{
      status = "rolled-back"
      backupPath = $BackupPath
      reason = "update failure"
    }
  }
  Write-ProgressEvent -Stage "rollback" -Percent 100 -Message "Rollback completed"
}

function Start-CameraConsole {
  param(
    [string]$InstallRoot,
    [string]$RestartMode
  )
  $startCmd = Join-Path $InstallRoot "start-all.cmd"
  if (-not (Test-Path -LiteralPath $startCmd)) {
    throw "start-all.cmd was not found."
  }
  $arguments = if ($RestartMode -eq "NoBrowser") { "/minimized /no-browser" } else { "" }
  Start-Process -FilePath $startCmd -ArgumentList $arguments -WorkingDirectory $InstallRoot
}

function Read-ConsolePort {
  param([string]$InstallRoot)
  $portsFile = Join-Path $InstallRoot "config\ports.env"
  $port = "3000"
  if (Test-Path -LiteralPath $portsFile) {
    foreach ($line in Get-Content -LiteralPath $portsFile) {
      if ($line -match "^\s*PORT\s*=\s*(\d+)\s*$") {
        $port = $Matches[1]
      }
    }
  }
  return $port
}

function Wait-ConsoleHealthy {
  param(
    [string]$InstallRoot,
    [int]$TimeoutSeconds = 60
  )
  $port = Read-ConsolePort -InstallRoot $InstallRoot
  $url = "http://127.0.0.1:$port/api/state"
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      $result = Invoke-RestMethod -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($result.ok) {
        return $true
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
  return $false
}

$installRoot = Resolve-Path $PSScriptRoot
$versionFile = Join-Path $installRoot "version.json"
$current = Read-JsonFile -Path $versionFile
$currentVersion = if ($current -and $current.version) { [string]$current.version } else { "0.0.0" }
$currentChannel = if ($Channel) { $Channel } elseif ($current -and $current.channel) { [string]$current.channel } else { "stable" }
if (-not $ManifestUrl) {
  $ManifestUrl = "http://www.fenqunshuju.com/releases/camera-local-console/channels/$currentChannel.json"
}

Write-Host "Current version: $currentVersion"
Write-Host "Channel: $currentChannel"
Write-Host "Manifest URL: $ManifestUrl"

$workDir = Join-Path $installRoot ".update"
$statePath = Join-Path $workDir "update-state.json"
$downloadPath = Join-Path $workDir "package.zip"
$extractPath = Join-Path $workDir "package"
$backupPath = Join-Path $installRoot (".backup-" + (Get-Date -Format "yyyyMMddHHmmss"))

try {
  Write-ProgressEvent -Stage "manifest" -Percent 0 -Message "Reading update manifest..."
  $manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
  $latestVersion = [string]$manifest.version
  if (-not $latestVersion -or -not $manifest.url) {
    throw "Invalid update manifest. Missing version or url."
  }

  Write-Host "Latest version: $latestVersion"
  Write-ProgressEvent -Stage "manifest" -Percent 100 -Message "Update manifest loaded: $latestVersion"

  if ($latestVersion -eq $currentVersion) {
    Write-ProgressEvent -Stage "done" -Percent 100 -Message "Already up to date: $currentVersion"
    Write-Host "Already up to date."
    exit 0
  }

  if ($CheckOnly) {
    Write-ProgressEvent -Stage "done" -Percent 100 -Message "Update available: $currentVersion -> $latestVersion"
    Write-Host "Update available: $currentVersion -> $latestVersion"
    exit 0
  }

  Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null

  Write-Host "Downloading: $($manifest.url)"
  Download-FileWithProgress -Url $manifest.url -OutFile $downloadPath

  if ($manifest.sha256) {
    Write-ProgressEvent -Stage "verify" -Percent 0 -Message "Verifying package..."
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
    $expected = ([string]$manifest.sha256).ToLowerInvariant()
    if ($actual -ne $expected) {
      throw "Package checksum mismatch. expected=$expected actual=$actual"
    }
    Write-ProgressEvent -Stage "verify" -Percent 100 -Message "Package verified"
  }

  Write-ProgressEvent -Stage "extract" -Percent 0 -Message "Extracting package..."
  Expand-ZipPackage -ZipPath $downloadPath -DestinationPath $extractPath
  Write-ProgressEvent -Stage "extract" -Percent 100 -Message "Package extracted"
  $packageRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if (-not $packageRoot) {
    throw "Invalid package structure. The zip does not contain a root directory."
  }

  Write-Host "Stopping running services..."
  Write-ProgressEvent -Stage "stop" -Percent 0 -Message "Stopping previous version..."
  Stop-CameraConsole -InstallRoot $installRoot
  Write-ProgressEvent -Stage "stop" -Percent 100 -Message "Previous version stopped"

  Write-Host "Creating backup: $backupPath"
  Write-ProgressEvent -Stage "backup" -Percent 0 -Message "Creating backup..."
  New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
  foreach ($item in Get-ChildItem -LiteralPath $installRoot -Force) {
    if ($item.Name -in @(".update") -or $item.Name.StartsWith(".backup-")) {
      continue
    }
    Copy-Item -LiteralPath $item.FullName -Destination $backupPath -Recurse -Force
  }
  Write-ProgressEvent -Stage "backup" -Percent 100 -Message "Backup completed"
  Write-UpdateState -StatePath $statePath -State @{
    status = "applying"
    backupPath = $backupPath
    targetVersion = $latestVersion
    previousVersion = $currentVersion
    manifestUrl = $ManifestUrl
  }

  Write-Host "Applying update..."
  Write-ProgressEvent -Stage "apply" -Percent 0 -Message "Applying new files..."
  Copy-UpdateContent -SourceRoot $packageRoot.FullName -TargetRoot $installRoot
  Write-ProgressEvent -Stage "apply" -Percent 100 -Message "New files applied"
  Write-UpdateState -StatePath $statePath -State @{
    status = "restarting"
    backupPath = $backupPath
    targetVersion = $latestVersion
    previousVersion = $currentVersion
    manifestUrl = $ManifestUrl
  }

  @{
    version = $latestVersion
    channel = $currentChannel
    updatedAt = (Get-Date).ToString("s")
    manifestUrl = $ManifestUrl
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versionFile -Encoding UTF8

  Write-Host "Update completed. Backup: $backupPath"
  Write-ProgressEvent -Stage "restart" -Percent 0 -Message "Restarting console..."
  Sync-AutostartShortcut -InstallRoot $installRoot
  if ($RestartMode -eq "None") {
    Write-Host "Restart skipped."
    Write-UpdateState -StatePath $statePath -State @{
      status = "done"
      backupPath = $backupPath
      targetVersion = $latestVersion
      previousVersion = $currentVersion
      manifestUrl = $ManifestUrl
    }
    Write-ProgressEvent -Stage "done" -Percent 100 -Message "Update completed. Restart skipped."
  } else {
    Write-Host "Restarting camera console..."
    Start-CameraConsole -InstallRoot $installRoot -RestartMode $RestartMode
    Write-ProgressEvent -Stage "health" -Percent 0 -Message "Checking new console health..."
    if (-not (Wait-ConsoleHealthy -InstallRoot $installRoot -TimeoutSeconds 60)) {
      throw "New console did not become healthy within 60 seconds."
    }
    Write-UpdateState -StatePath $statePath -State @{
      status = "done"
      backupPath = $backupPath
      targetVersion = $latestVersion
      previousVersion = $currentVersion
      manifestUrl = $ManifestUrl
    }
    Write-ProgressEvent -Stage "done" -Percent 100 -Message "Update completed. Console restarted."
  }
} catch {
  $errorMessage = $_.Exception.Message
  Write-Host "Update failed: $errorMessage"
  if (Test-Path -LiteralPath $backupPath) {
    Write-ProgressEvent -Stage "rollback" -Percent 0 -Message "Update failed. Rolling back: $errorMessage"
    Restore-Backup -BackupPath $backupPath -InstallRoot $installRoot -StatePath $statePath
    if ($RestartMode -ne "None") {
      Start-CameraConsole -InstallRoot $installRoot -RestartMode $RestartMode
      if (Wait-ConsoleHealthy -InstallRoot $installRoot -TimeoutSeconds 60) {
        Write-ProgressEvent -Stage "rollback" -Percent 100 -Message "Update failed. Previous version restored and started."
      } else {
        Write-ProgressEvent -Stage "error" -Percent 100 -Message "Update failed. Rolled back, but previous version health check failed."
        throw
      }
    }
    throw "Update failed and rolled back to previous version: $errorMessage"
  } else {
    if (Test-Path -LiteralPath $statePath) {
      Write-UpdateState -StatePath $statePath -State @{
        status = "failed-before-apply"
        reason = $errorMessage
        manifestUrl = $ManifestUrl
      }
    } else {
      New-Item -ItemType Directory -Force -Path $workDir | Out-Null
      Write-UpdateState -StatePath $statePath -State @{
        status = "failed-before-apply"
        reason = $errorMessage
        manifestUrl = $ManifestUrl
      }
    }
    Write-ProgressEvent -Stage "error" -Percent 100 -Message "Update failed before applying files: $errorMessage"
    throw "Update failed before applying files: $errorMessage"
  }
}
