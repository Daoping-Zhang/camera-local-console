param(
  [string]$ManifestUrl = "",
  [string]$Channel = "",
  [ValidateSet("Normal", "NoBrowser", "None")]
  [string]$RestartMode = "Normal",
  [switch]$CheckOnly
)

$ErrorActionPreference = "Stop"

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

function Download-FileWithProgress {
  param(
    [string]$Url,
    [string]$OutFile
  )
  Write-ProgressEvent -Stage "download" -Percent 0 -Message "正在连接下载服务器..."
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
            Write-ProgressEvent -Stage "download" -Percent $percent -Message ("正在下载更新包 {0}%" -f $percent)
            $lastPercent = $percent
          }
        } else {
          Write-ProgressEvent -Stage "download" -Percent 0 -Message ("正在下载更新包 {0:n1} MB" -f ($readTotal / 1MB))
        }
      }
    } finally {
      $outputStream.Close()
      $inputStream.Close()
    }
  } finally {
    $response.Close()
  }
  Write-ProgressEvent -Stage "download" -Percent 100 -Message "更新包下载完成"
}

function Stop-CameraConsole {
  taskkill /FI "WINDOWTITLE eq camera-console*" /T /F | Out-Null
  taskkill /FI "WINDOWTITLE eq camera-console-3000*" /T /F | Out-Null
  taskkill /FI "WINDOWTITLE eq camera-collector-3100*" /T /F | Out-Null
}

function Copy-UpdateContent {
  param(
    [string]$SourceRoot,
    [string]$TargetRoot
  )

  $preserve = @("config", "data", "logs")
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

$manifest = Invoke-RestMethod -Uri $ManifestUrl -UseBasicParsing
$latestVersion = [string]$manifest.version
if (-not $latestVersion -or -not $manifest.url) {
  throw "Invalid update manifest. Required fields: version, url"
}

Write-Host "Latest version: $latestVersion"

if ($latestVersion -eq $currentVersion) {
  Write-Host "Already up to date."
  exit 0
}

if ($CheckOnly) {
  Write-Host "Update available: $currentVersion -> $latestVersion"
  exit 0
}

$workDir = Join-Path $installRoot ".update"
$downloadPath = Join-Path $workDir "package.zip"
$extractPath = Join-Path $workDir "package"
$backupPath = Join-Path $installRoot (".backup-" + (Get-Date -Format "yyyyMMddHHmmss"))

Remove-Item -LiteralPath $workDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

Write-Host "Downloading: $($manifest.url)"
Download-FileWithProgress -Url $manifest.url -OutFile $downloadPath

if ($manifest.sha256) {
  Write-ProgressEvent -Stage "verify" -Percent 0 -Message "正在校验安装包..."
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $downloadPath).Hash.ToLowerInvariant()
  $expected = ([string]$manifest.sha256).ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "SHA256 mismatch. expected=$expected actual=$actual"
  }
  Write-ProgressEvent -Stage "verify" -Percent 100 -Message "安装包校验完成"
}

Write-ProgressEvent -Stage "extract" -Percent 0 -Message "正在解压安装包..."
Expand-Archive -LiteralPath $downloadPath -DestinationPath $extractPath -Force
Write-ProgressEvent -Stage "extract" -Percent 100 -Message "安装包解压完成"
$packageRoot = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
if (-not $packageRoot) {
  throw "Package zip does not contain a root directory."
}

Write-Host "Stopping running services..."
Write-ProgressEvent -Stage "stop" -Percent 0 -Message "正在停止旧版本..."
Stop-CameraConsole
Write-ProgressEvent -Stage "stop" -Percent 100 -Message "旧版本已停止"

Write-Host "Creating backup: $backupPath"
Write-ProgressEvent -Stage "backup" -Percent 0 -Message "正在备份旧版本..."
New-Item -ItemType Directory -Force -Path $backupPath | Out-Null
foreach ($item in Get-ChildItem -LiteralPath $installRoot -Force) {
  if ($item.Name -in @(".update") -or $item.Name.StartsWith(".backup-")) {
    continue
  }
  Copy-Item -LiteralPath $item.FullName -Destination $backupPath -Recurse -Force
}
Write-ProgressEvent -Stage "backup" -Percent 100 -Message "旧版本备份完成"

Write-Host "Applying update..."
Write-ProgressEvent -Stage "apply" -Percent 0 -Message "正在覆盖新版文件..."
Copy-UpdateContent -SourceRoot $packageRoot.FullName -TargetRoot $installRoot
Write-ProgressEvent -Stage "apply" -Percent 100 -Message "新版文件覆盖完成"

@{
  version = $latestVersion
  channel = $currentChannel
  updatedAt = (Get-Date).ToString("s")
  manifestUrl = $ManifestUrl
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $versionFile -Encoding UTF8

Write-Host "Update completed. Backup: $backupPath"
Write-ProgressEvent -Stage "restart" -Percent 0 -Message "正在重启控制台..."
Sync-AutostartShortcut -InstallRoot $installRoot
$startCmd = Join-Path $installRoot "start-all.cmd"
if ($RestartMode -eq "None") {
  Write-Host "Restart skipped."
} elseif (Test-Path -LiteralPath $startCmd) {
  Write-Host "Restarting camera console..."
  $arguments = if ($RestartMode -eq "NoBrowser") { "/minimized /no-browser" } else { "" }
  Start-Process -FilePath $startCmd -ArgumentList $arguments -WorkingDirectory $installRoot
  Write-ProgressEvent -Stage "done" -Percent 100 -Message "更新完成，控制台已重启"
} else {
  Write-Host "start-all.cmd was not found. Please start the console manually."
  Write-ProgressEvent -Stage "done" -Percent 100 -Message "更新完成，请手动启动控制台"
}
