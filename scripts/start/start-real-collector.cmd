@echo off
setlocal
set "NODE_EXE=C:\Users\Yang XinTong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
set "PYTHON_PATH=C:\Users\Yang XinTong\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "COLLECTOR_ADAPTER=hikvision"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then run: node scripts\runtime\collector-server.js
  pause
  exit /b 1
)
set "NODE_EXE=node"
:run
cd /d "%~dp0..\.."
"%NODE_EXE%" scripts\runtime\collector-server.js

