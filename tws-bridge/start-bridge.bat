@echo off
title TWS Bridge
cd /d "%~dp0"
if not exist node_modules\ws (
  echo Installing dependencies...
  call npm install
)
echo Starting TWS Bridge...
node server.js
pause
