@echo off
cd /d "%~dp0"
echo Same as start.bat (dual port hub).
node src\cli.js start %*
if errorlevel 1 pause
