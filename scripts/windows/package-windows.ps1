param(
  [string]$OutputRoot = "dist",
  [string]$PackageName = "camera-local-console-win-x64",
  [string]$Version = "",
  [string]$Channel = "local",
  [string]$NodeDir = "",
  [string]$PythonDir = "",
  [switch]$SkipSdk,
  [switch]$NoZip
)

$ErrorActionPreference = "Stop"

function Resolve-OptionalPath {
  param([string[]]$Candidates)
  foreach ($candidate in $Candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) {
      return (Resolve-Path -LiteralPath $candidate).Path
    }
  }
  return ""
}

function Copy-DirectoryContent {
  param(
    [string]$Source,
    [string]$Target
  )
  if (-not (Test-Path -LiteralPath $Source)) {
    throw "Source not found: $Source"
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Target -Recurse -Force
  }
}

function Find-WindowsSdkDir {
  param([string]$WorkspaceRoot)

  $vendorDir = Join-Path $WorkspaceRoot "camera-local-console\vendor\hikvision\win-x64"
  if (Test-Path -LiteralPath (Join-Path $vendorDir "HCNetSDK.dll")) {
    return (Resolve-Path -LiteralPath $vendorDir).Path
  }

  $sdkRoot = Get-ChildItem -LiteralPath $WorkspaceRoot -Directory -Filter "HCNetSDK*Win64*" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sdkRoot) {
    return ""
  }

  $sdkDll = Get-ChildItem -LiteralPath $sdkRoot.FullName -Recurse -File -Filter "HCNetSDK.dll" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $sdkDll) {
    return ""
  }

  return $sdkDll.Directory.FullName
}

function Copy-LightPythonRuntime {
  param(
    [string]$Source,
    [string]$Target
  )

  New-Item -ItemType Directory -Force -Path $Target | Out-Null

  $rootFiles = @(
    "python.exe",
    "pythonw.exe",
    "python3.dll",
    "python312.dll",
    "vcruntime140.dll",
    "vcruntime140_1.dll",
    "LICENSE.txt"
  )
  foreach ($file in $rootFiles) {
    $sourceFile = Join-Path $Source $file
    if (Test-Path -LiteralPath $sourceFile) {
      Copy-Item -LiteralPath $sourceFile -Destination $Target -Force
    }
  }

  foreach ($dir in @("DLLs", "libs")) {
    $sourceDir = Join-Path $Source $dir
    if (Test-Path -LiteralPath $sourceDir) {
      Copy-DirectoryContent -Source $sourceDir -Target (Join-Path $Target $dir)
    }
  }

  $libSource = Join-Path $Source "Lib"
  $libTarget = Join-Path $Target "Lib"
  if (-not (Test-Path -LiteralPath $libSource)) {
    throw "Python Lib directory not found: $libSource"
  }
  New-Item -ItemType Directory -Force -Path $libTarget | Out-Null
  $excludeDirs = @("site-packages", "test", "tests", "idlelib", "tkinter", "turtledemo", "ensurepip", "venv", "distutils")
  Get-ChildItem -LiteralPath $libSource -Force | Where-Object {
    -not ($_.PSIsContainer -and $excludeDirs -contains $_.Name)
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $libTarget -Recurse -Force
  }
}

$projectRoot = Resolve-Path "$PSScriptRoot\..\.."
$workspaceRoot = Resolve-Path "$projectRoot\.."
if (-not $Version) {
  $packageJson = Get-Content -LiteralPath (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
  $Version = [string]$packageJson.version
}
$outputDir = Join-Path $projectRoot $OutputRoot
$packageDir = Join-Path $outputDir $PackageName

if (Test-Path -LiteralPath $packageDir) {
  Remove-Item -LiteralPath $packageDir -Recurse -Force
}

New-Item -ItemType Directory -Force -Path $packageDir | Out-Null

$appDir = Join-Path $packageDir "app"
$runtimeDir = Join-Path $packageDir "runtime"
$configDir = Join-Path $packageDir "config"
$logsDir = Join-Path $packageDir "logs"
$dataDir = Join-Path $packageDir "data"

New-Item -ItemType Directory -Force -Path $appDir,$runtimeDir,$configDir,$logsDir,$dataDir | Out-Null

Copy-DirectoryContent -Source (Join-Path $projectRoot "src") -Target (Join-Path $appDir "src")
Copy-DirectoryContent -Source (Join-Path $projectRoot "scripts") -Target (Join-Path $appDir "scripts")
Copy-Item -LiteralPath (Join-Path $projectRoot "package.json") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "data\config.example.json") -Destination (Join-Path $dataDir "config.json") -Force
if (Test-Path -LiteralPath (Join-Path $projectRoot ".env.example")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") -Destination (Join-Path $configDir ".env.example") -Force
}
@'
PORT=3000
COLLECTOR_PORT=3100
'@ | Set-Content -Path (Join-Path $configDir "ports.env") -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\windows\update-windows.ps1") -Destination (Join-Path $packageDir "update-windows.ps1") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\windows\recovery-check.ps1") -Destination (Join-Path $packageDir "recovery-check.ps1") -Force
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\windows\stop-all.ps1") -Destination (Join-Path $packageDir "stop-all.ps1") -Force
@{
  version = $Version
  channel = $Channel
  builtAt = (Get-Date).ToString("s")
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $packageDir "version.json") -Encoding UTF8

$resolvedNodeDir = Resolve-OptionalPath @(
  $NodeDir,
  "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\node"
)
if ($resolvedNodeDir) {
  $nodeExe = Resolve-OptionalPath @(
    (Join-Path $resolvedNodeDir "bin\node.exe"),
    (Join-Path $resolvedNodeDir "node.exe")
  )
  if (-not $nodeExe) {
    throw "node.exe not found under $resolvedNodeDir"
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $runtimeDir "node\bin") | Out-Null
  Copy-Item -LiteralPath $nodeExe -Destination (Join-Path $runtimeDir "node\bin\node.exe") -Force
} else {
  Write-Warning "Node runtime was not copied. The package will require node in PATH."
}

$resolvedPythonDir = Resolve-OptionalPath @(
  $PythonDir,
  "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python"
)
if ($resolvedPythonDir) {
  Copy-LightPythonRuntime -Source $resolvedPythonDir -Target (Join-Path $runtimeDir "python")
} else {
  Write-Warning "Python runtime was not copied. The package will require python in PATH."
}

if (-not $SkipSdk) {
  $sdkSource = Find-WindowsSdkDir -WorkspaceRoot $workspaceRoot
  if ($sdkSource) {
    Copy-DirectoryContent -Source $sdkSource -Target (Join-Path $packageDir "sdk\hikvision")
  } else {
    Write-Warning "Hikvision Win64 SDK was not copied. Put SDK files under sdk\hikvision before running."
  }
}

@'
@echo off
setlocal
cd /d "%~dp0"

set "NO_BROWSER=0"
set "START_MINIMIZED=0"
set "START_CONSOLE=0"
for %%A in (%*) do (
  if /i "%%A"=="/no-browser" set "NO_BROWSER=1"
  if /i "%%A"=="/minimized" set "START_MINIMIZED=1"
  if /i "%%A"=="/console" set "START_CONSOLE=1"
)

set "APP_DIR=%~dp0app"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0recovery-check.ps1"
if errorlevel 1 (
  echo.
  echo Startup recovery failed. Please check the update state manually.
  echo.
  pause
  exit /b 1
)
set "PORT=3000"
set "COLLECTOR_PORT=3100"
if exist "%~dp0config\ports.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0config\ports.env") do (
    if /i "%%A"=="PORT" set "PORT=%%B"
    if /i "%%A"=="COLLECTOR_PORT" set "COLLECTOR_PORT=%%B"
  )
)
set "LOCAL_COLLECTOR_URL=http://127.0.0.1:%COLLECTOR_PORT%"
if "%PORT%"=="%COLLECTOR_PORT%" (
  echo.
  echo PORT and COLLECTOR_PORT cannot be the same value: %PORT%
  echo Please edit config\ports.env, then run start-all.cmd again.
  echo.
  pause
  exit /b 1
)
for %%P in (%PORT% %COLLECTOR_PORT%) do (
  powershell -NoProfile -Command "$p=%%P; if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) { $hit=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue } else { $hit=netstat -ano | Select-String (':' + $p + '\s+.*LISTENING') }; if ($hit) { exit 1 } else { exit 0 }" >nul 2>nul
  if errorlevel 1 (
    echo.
    echo Port %%P is already in use.
    echo Please edit config\ports.env, change PORT or COLLECTOR_PORT, then run start-all.cmd again.
    echo.
    pause
    exit /b 1
  )
)
set "NODE_EXE=%~dp0runtime\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=%~dp0runtime\node\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

set "PYTHON_PATH=%~dp0runtime\python\python.exe"
if not exist "%PYTHON_PATH%" set "PYTHON_PATH=python"

set "GATEWAY_URL=http://127.0.0.1:%PORT%"
set "HIK_SDK_DIR=%~dp0sdk\hikvision"
set "COLLECTOR_ADAPTER=hikvision"

if "%NO_BROWSER%"=="0" powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0open-starting-page.ps1" -Port "%PORT%" -InstallRoot "%~dp0"

if "%START_CONSOLE%"=="1" (
  if "%START_MINIMIZED%"=="1" (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-console.ps1" -InstallRoot "%~dp0" -Console -Minimized
  ) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-console.ps1" -InstallRoot "%~dp0" -Console
  )
) else (
  powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0start-console.ps1" -InstallRoot "%~dp0"
)
timeout /t 2 /nobreak >nul
'@ | Set-Content -Path (Join-Path $packageDir "start-all.cmd") -Encoding ASCII

@'
param(
  [string]$InstallRoot = $PSScriptRoot,
  [switch]$Console,
  [switch]$Minimized
)

$ErrorActionPreference = "Stop"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$appDir = Join-Path $InstallRoot "app"
$portsFile = Join-Path $InstallRoot "config\ports.env"
$port = "3000"
$collectorPort = "3100"
if (Test-Path -LiteralPath $portsFile) {
  foreach ($line in Get-Content -LiteralPath $portsFile) {
    if ($line -match "^\s*PORT\s*=\s*(\d+)\s*$") {
      $port = $Matches[1]
    }
    if ($line -match "^\s*COLLECTOR_PORT\s*=\s*(\d+)\s*$") {
      $collectorPort = $Matches[1]
    }
  }
}

$nodeExe = Join-Path $InstallRoot "runtime\node\bin\node.exe"
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeExe = Join-Path $InstallRoot "runtime\node\node.exe"
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeExe = "node"
}

$serverScript = Join-Path $appDir "src\server.js"
if (-not (Test-Path -LiteralPath $serverScript)) {
  throw "server.js not found: $serverScript"
}

$env:PORT = $port
$env:COLLECTOR_PORT = $collectorPort
$env:LOCAL_COLLECTOR_URL = "http://127.0.0.1:$collectorPort"
$env:GATEWAY_URL = "http://127.0.0.1:$port"
$env:HIK_SDK_DIR = Join-Path $InstallRoot "sdk\hikvision"
$pythonPath = Join-Path $InstallRoot "runtime\python\python.exe"
$env:PYTHON_PATH = if (Test-Path -LiteralPath $pythonPath) { $pythonPath } else { "python" }
$env:COLLECTOR_ADAPTER = "hikvision"

if ($Console) {
  $windowStyle = if ($Minimized) { "Minimized" } else { "Normal" }
  Start-Process -FilePath "cmd.exe" -ArgumentList @("/k", "`"$nodeExe`" `"$serverScript`"") -WorkingDirectory $appDir -WindowStyle $windowStyle
} else {
  Start-Process -FilePath $nodeExe -ArgumentList @($serverScript) -WorkingDirectory $appDir -WindowStyle Hidden
}
'@ | Set-Content -Path (Join-Path $packageDir "start-console.ps1") -Encoding ASCII

@'
@echo off
setlocal
set "PORT=3000"
if exist "%~dp0config\ports.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0config\ports.env") do (
    if /i "%%A"=="PORT" set "PORT=%%B"
  )
)
start "" "http://127.0.0.1:%PORT%"
'@ | Set-Content -Path (Join-Path $packageDir "open-console.cmd") -Encoding ASCII

@'
param(
  [string]$Port = "3000",
  [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$startupDir = Join-Path $InstallRoot ".startup"
New-Item -ItemType Directory -Force -Path $startupDir | Out-Null
$consoleUrl = "http://127.0.0.1:$Port"
$healthUrl = "$consoleUrl/api/state"
$pagePath = Join-Path $startupDir "console-starting.html"

@"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>正在启动本地控制台</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#111827;font-family:Arial,"Microsoft YaHei",sans-serif}
    main{width:min(520px,calc(100vw - 32px));background:white;border:1px solid #d8dee9;border-radius:10px;padding:24px;box-shadow:0 18px 50px rgba(15,23,42,.08)}
    h1,p{margin:0}
    h1{font-size:22px}
    p{margin-top:10px;color:#64748b;line-height:1.6}
    .bar{height:8px;background:#e5e7eb;border-radius:999px;overflow:hidden;margin-top:18px}
    .bar span{display:block;width:45%;height:100%;background:#047857;border-radius:999px;animation:move 1.2s infinite ease-in-out}
    .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
    a{display:inline-flex;align-items:center;min-height:36px;padding:0 14px;border-radius:6px;background:#047857;color:white;text-decoration:none;font-weight:700}
    a.secondary{background:white;color:#344054;border:1px solid #cbd5e1}
    @keyframes move{0%{transform:translateX(-110%)}100%{transform:translateX(240%)}}
  </style>
</head>
<body>
  <main>
    <h1>正在启动本地控制台</h1>
    <p id="status">服务正在后台启动，启动完成后会自动进入控制台。</p>
    <div class="bar"><span></span></div>
    <div class="actions">
      <a href="$consoleUrl">手动打开控制台</a>
      <a class="secondary" href="$healthUrl">查看服务状态</a>
    </div>
  </main>
  <script>
    const consoleUrl = "$consoleUrl";
    const healthUrl = "$healthUrl";
    let attempts = 0;
    async function check() {
      attempts += 1;
      try {
        await fetch(healthUrl + "?t=" + Date.now(), { cache: "no-store", mode: "no-cors" });
        document.getElementById("status").textContent = "启动完成，正在进入控制台...";
        location.href = consoleUrl;
        return;
      } catch {}
      document.getElementById("status").textContent = attempts > 20
        ? "启动时间较长，请稍等，或点击下方按钮手动打开控制台。"
        : "服务正在后台启动，启动完成后会自动进入控制台。";
      setTimeout(check, 1200);
    }
    setTimeout(check, 800);
  </script>
</body>
</html>
"@ | Set-Content -LiteralPath $pagePath -Encoding UTF8

Start-Process -FilePath $pagePath
'@ | Set-Content -Path (Join-Path $packageDir "open-starting-page.ps1") -Encoding UTF8

@'
@echo off
chcp 65001 >nul
powershell -ExecutionPolicy Bypass -File "%~dp0update-windows.ps1" %*
pause
'@ | Set-Content -Path (Join-Path $packageDir "update.cmd") -Encoding ASCII

@'
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-all.ps1" -InstallRoot "%~dp0"
pause
'@ | Set-Content -Path (Join-Path $packageDir "stop-all.cmd") -Encoding ASCII

@'
@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart-task.ps1" -InstallRoot "%~dp0" -Enable
pause
'@ | Set-Content -Path (Join-Path $packageDir "enable-autostart.cmd") -Encoding ASCII

@'
@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart-task.ps1" -InstallRoot "%~dp0" -Disable
pause
'@ | Set-Content -Path (Join-Path $packageDir "disable-autostart.cmd") -Encoding ASCII

@'
param(
  [string]$InstallRoot = $PSScriptRoot,
  [switch]$Enable,
  [switch]$Disable
)

$ErrorActionPreference = "Stop"
$TaskName = "CameraLocalConsoleWatchdog"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path

function Remove-LegacyShortcut {
  $startup = [Environment]::GetFolderPath("Startup")
  $shortcut = Join-Path $startup "camera-local-console.lnk"
  if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut -Force
    Write-Host "Removed legacy startup shortcut: $shortcut"
  }
}

function Register-WatchdogTask {
  $script = Join-Path $InstallRoot "watchdog-autostart.ps1"
  if (-not (Test-Path -LiteralPath $script)) {
    throw "watchdog-autostart.ps1 not found: $script"
  }
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -InstallRoot `"$InstallRoot`""
  $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
  $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($triggerLogon,$triggerRepeat) -Settings $settings -Description "Keep camera local console running." -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Remove-LegacyShortcut
  Write-Host "Enabled scheduled watchdog: $TaskName"
}

function Unregister-WatchdogTask {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Disabled scheduled watchdog: $TaskName"
  } else {
    Write-Host "Scheduled watchdog was not enabled."
  }
  Remove-LegacyShortcut
}

if ($Enable) {
  Register-WatchdogTask
} elseif ($Disable) {
  Unregister-WatchdogTask
} else {
  throw "Use -Enable or -Disable."
}
'@ | Set-Content -Path (Join-Path $packageDir "autostart-task.ps1") -Encoding ASCII

@'
param(
  [string]$InstallRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$InstallRoot = (Resolve-Path -LiteralPath $InstallRoot).Path
$portsFile = Join-Path $InstallRoot "config\ports.env"
$port = "3000"
if (Test-Path -LiteralPath $portsFile) {
  foreach ($line in Get-Content -LiteralPath $portsFile) {
    if ($line -match "^\s*PORT\s*=\s*(\d+)\s*$") {
      $port = $Matches[1]
    }
  }
}

$healthUrl = "http://127.0.0.1:$port/api/state"
$healthy = $false
try {
  $response = Invoke-WebRequest -Uri $healthUrl -UseBasicParsing -TimeoutSec 5
  $healthy = $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
} catch {
  $healthy = $false
}

if ($healthy) {
  Write-Host "Camera local console is healthy: $healthUrl"
  exit 0
}

$startCmd = Join-Path $InstallRoot "start-all.cmd"
if (-not (Test-Path -LiteralPath $startCmd)) {
  throw "start-all.cmd not found: $startCmd"
}

Write-Host "Camera local console is not healthy. Starting..."
Start-Process -FilePath $startCmd -ArgumentList "/no-browser" -WorkingDirectory $InstallRoot
'@ | Set-Content -Path (Join-Path $packageDir "watchdog-autostart.ps1") -Encoding ASCII

@"
摄像头本地控制台 Windows 安装包

一、启动
  双击 start-all.cmd
  默认后台启动，不显示终端窗口，会先打开“正在启动本地控制台”等待页。

  不打开浏览器：
    start-all.cmd /no-browser

  调试时显示终端：
    start-all.cmd /console

  调试时显示终端但最小化：
    start-all.cmd /console /minimized /no-browser

  内部启动脚本：
    start-console.ps1

二、打开控制台
  open-console.cmd

  默认地址：
    http://127.0.0.1:3000

三、停止
  stop-all.cmd

四、更新
  update.cmd

  推荐在 3000 控制台的“版本更新”页面里执行在线更新。

五、自启动和自恢复
  enable-autostart.cmd
  disable-autostart.cmd

  启用后会创建 Windows 计划任务：
    CameraLocalConsoleWatchdog

  计划任务会在用户登录时运行，并且每 1 分钟检查一次。
  如果本地控制台不可访问，会自动后台拉起 start-all.cmd。

六、端口
  本地控制台：http://127.0.0.1:3000
  本地采集器：http://127.0.0.1:3100

  如果端口被占用，请修改：
    config\ports.env

七、海康 SDK 目录
  sdk\hikvision
"@ | Set-Content -Path (Join-Path $packageDir "README-WINDOWS.txt") -Encoding UTF8

if (-not $NoZip) {
  Compress-Archive -LiteralPath $packageDir -DestinationPath (Join-Path $outputDir "$PackageName.zip") -Force
}

Write-Host "Windows package created:"
Write-Host "  $packageDir"
if (-not $NoZip) {
  Write-Host "  $(Join-Path $outputDir "$PackageName.zip")"
}
