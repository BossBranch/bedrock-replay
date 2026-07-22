@echo off
cd /d "%~dp0"
title Bedrock Replay Launcher

set "APP=%~dp0"
if "%APP:~-1%"=="\" set "APP=%APP:~0,-1%"
set "ELE=%APP%\node_modules\electron\dist\electron.exe"

if not exist "%ELE%" (
  echo Electron not found. Installing...
  where npm.cmd >nul 2>nul
  if errorlevel 1 (
    echo ERROR: npm.cmd not in PATH.
    pause
    exit /b 1
  )
  call npm.cmd install
  if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

if not exist "%ELE%" (
  echo ERROR: still no electron.exe
  echo %ELE%
  pause
  exit /b 1
)

REM Detach GUI ? black console closes immediately
start "" /D "%APP%" "%ELE%" "%APP%"
exit /b 0
