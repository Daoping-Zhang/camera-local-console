@echo off
setlocal
cd /d "%~dp0.."
set "NODE_EXE=C:\Users\Yang XinTong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%NODE_EXE%" goto run
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 20 or newer, then run: node scripts\mock-hik-contact-data.js
  pause
  exit /b 1
)
set "NODE_EXE=node"
:run
"%NODE_EXE%" scripts\mock-hik-contact-data.js
