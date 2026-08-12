@echo off
setlocal
cd /d "%~dp0..\.."
set "NODE_EXE=C:\Users\Yang XinTong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"
"%NODE_EXE%" release-admin\server.js

