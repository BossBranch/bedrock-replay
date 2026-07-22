@echo off
cd /d "%~dp0"
echo PLAY port only (default :19133). Prefer start.bat for both ports.
node src\cli.js play %*
if errorlevel 1 pause
