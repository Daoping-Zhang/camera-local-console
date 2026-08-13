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
if (Test-Path -LiteralPath (Join-Path $projectRoot ".env.example")) {
  Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") -Destination (Join-Path $configDir ".env.example") -Force
}
@'
PORT=3000
COLLECTOR_PORT=3100
'@ | Set-Content -Path (Join-Path $configDir "ports.env") -Encoding ASCII
Copy-Item -LiteralPath (Join-Path $projectRoot "scripts\windows\update-windows.ps1") -Destination (Join-Path $packageDir "update-windows.ps1") -Force
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

set "APP_DIR=%~dp0app"
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

start "camera-console" cmd /k ""%NODE_EXE%" "%APP_DIR%\src\server.js""
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:%PORT%"
'@ | Set-Content -Path (Join-Path $packageDir "start-all.cmd") -Encoding ASCII

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
@echo off
powershell -ExecutionPolicy Bypass -File "%~dp0update-windows.ps1" %*
pause
'@ | Set-Content -Path (Join-Path $packageDir "update.cmd") -Encoding ASCII

@'
@echo off
taskkill /FI "WINDOWTITLE eq camera-console*" /T /F >nul 2>nul
taskkill /FI "WINDOWTITLE eq camera-collector-3100*" /T /F >nul 2>nul
echo stopped
pause
'@ | Set-Content -Path (Join-Path $packageDir "stop-all.cmd") -Encoding ASCII

@"
camera-local-console Windows package

Start:
  start-all.cmd

Open console:
  open-console.cmd

Stop:
  stop-all.cmd

Update:
  update.cmd

Ports:
  Default console:   http://127.0.0.1:3000
  Default collector: http://127.0.0.1:3100
  If a port is already in use, edit config\ports.env and run start-all.cmd again.

SDK path:
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
