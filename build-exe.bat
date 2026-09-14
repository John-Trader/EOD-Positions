@echo off
REM Builds dist\PositionCalc-<version>-portable.exe — one file, runs anywhere.
REM ELECTRON_RUN_AS_NODE can leak in from IDE terminals; clear it so the
REM builder's Electron invocations behave normally.
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0"
if not exist node_modules (
    echo Installing dependencies (first run downloads Electron, ~1GB)...
    call npm install
    if errorlevel 1 exit /b 1
)
call npm run dist
